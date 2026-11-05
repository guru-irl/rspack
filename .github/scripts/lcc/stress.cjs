// Runs one stress variant against several bindings and compares them.
// Usage: node stress.cjs <repo root> <work dir> <results dir> <variant name> '<variant json>' '<bindings json>'
// variant json: { spec: <gen.cjs spec>, options: <run-one.cjs options>, runs: n, arms: [names] }
// bindings json: { <arm name>: <absolute .node path> }
// Exits 1 if any build fails, the outputs differ, or the merge sequences differ.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [repoRoot, workDir, resultsDir, name, variantJson, bindingsJson] = process.argv.slice(2);
const variant = JSON.parse(variantJson);
const bindings = JSON.parse(bindingsJson);
const fixture = path.join(workDir, "fixtures", name);
const out = path.join(workDir, "out", name);
const logs = path.join(resultsDir, name);
fs.mkdirSync(logs, { recursive: true });

const gen = spawnSync(process.execPath, [path.join(__dirname, "gen.cjs"), fixture, JSON.stringify(variant.spec)], {
  encoding: "utf8",
});
if (gen.status !== 0) {
  console.error(gen.stderr);
  process.exit(1);
}

const STATS_PREFIX = "[rspack-limit-chunk-count] ";
const records = [];
let failed = false;
for (let run = 1; run <= variant.runs; run++) {
  // Rotate the arm order between runs.
  const arms = variant.arms.map((_, i) => variant.arms[(i + run - 1) % variant.arms.length]);
  for (const arm of arms) {
    const started = Date.now();
    const child = spawnSync(
      process.execPath,
      [path.join(__dirname, "run-one.cjs"), repoRoot, fixture, path.join(out, arm), JSON.stringify(variant.options)],
      {
        encoding: "utf8",
        env: { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: bindings[arm] },
        maxBuffer: 512 * 1024 * 1024,
        timeout: 50 * 60 * 1000,
      },
    );
    fs.writeFileSync(path.join(logs, `${arm}-run${run}.stdout.log`), child.stdout ?? "");
    fs.writeFileSync(path.join(logs, `${arm}-run${run}.stderr.log`), child.stderr ?? "");
    const stats = (child.stderr ?? "")
      .split("\n")
      .filter((line) => line.startsWith(STATS_PREFIX))
      .map((line) => JSON.parse(line.slice(STATS_PREFIX.length)));
    const lastLine = (child.stdout ?? "").trim().split("\n").pop();
    let result = null;
    try {
      result = JSON.parse(lastLine);
    } catch {}
    const ok = child.status === 0 && result !== null;
    if (!ok) failed = true;
    const { manifest, ...summary } = result ?? {};
    records.push({ arm, run, exit: child.status, signal: child.signal, elapsedMs: Date.now() - started, result: summary, stats });
    if (manifest) fs.writeFileSync(path.join(logs, `${arm}-run${run}.manifest.json`), JSON.stringify(manifest, null, 1));
    console.log(
      `${name} run ${run} ${arm}: exit=${child.status} wall=${summary.wallMs?.toFixed(0)}ms optimizeChunks=${summary.optimizeChunksMs?.toFixed(0)}ms chunks=${summary.chunks} output=${summary.manifestSha256?.slice(0, 12)} stats=${JSON.stringify(stats)}`,
    );
  }
}

function median(values) {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const byArm = {};
for (const arm of variant.arms) {
  const own = records.filter((record) => record.arm === arm && record.exit === 0);
  byArm[arm] = {
    runs: own.length,
    wallMs: median(own.map((record) => record.result.wallMs)),
    optimizeChunksMs: median(own.map((record) => record.result.optimizeChunksMs)),
    peakRssKiB: median(own.map((record) => record.result.peakRssKiB)),
    bindingSha256: own[0]?.result.bindingSha256 ?? null,
    pluginTotalMs: median(own.flatMap((record) => record.stats.map((line) => line.total_ms))),
  };
}

const outputs = new Set(records.filter((record) => record.exit === 0).map((record) => record.result.manifestSha256));
const digests = new Set(records.flatMap((record) => record.stats.map((line) => line.digest)));
const shadowEqual = records.flatMap((record) => record.stats.filter((line) => "shadow_equal" in line).map((line) => line.shadow_equal));
const counters = records.find((record) => record.arm === "instrumented")?.stats ?? [];

const summary = {
  name,
  variant,
  byArm,
  outputIdentical: outputs.size === 1,
  outputSha256: [...outputs],
  digestsIdentical: digests.size <= 1,
  digests: [...digests],
  shadowEqualAll: shadowEqual.length > 0 ? shadowEqual.every(Boolean) : null,
  instrumentedCounters: counters,
  failed,
  records,
};
fs.writeFileSync(path.join(resultsDir, `${name}.summary.json`), JSON.stringify(summary, null, 1));

const verdict = !failed && summary.outputIdentical && summary.digestsIdentical && summary.shadowEqualAll !== false;
console.log(
  `SUMMARY ${name}: ${verdict ? "PASS" : "FAIL"} outputs=${outputs.size} digests=${digests.size} shadowEqual=${summary.shadowEqualAll} ${JSON.stringify(byArm)}`,
);
process.exit(verdict ? 0 : 1);
