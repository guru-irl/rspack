const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const median = (values) => {
  if (!values.length) throw new Error("cannot summarize an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function interval(deltas) {
  if (deltas.length < 5 || deltas.some((x) => !Number.isFinite(x))) {
    throw new Error("at least five finite paired deltas are required");
  }
  let state = 0x5eed1234;
  const draws = [];
  for (let r = 0; r < 20000; r++) {
    const sample = [];
    for (let i = 0; i < deltas.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      sample.push(deltas[(state >>> 0) % deltas.length]);
    }
    draws.push(median(sample));
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * (draws.length - 1))], draws[Math.floor(0.975 * (draws.length - 1))]];
}
const sameManifest = (a, b) => Boolean(a && b && a === b);
const validHookCalls = (calls, enabled) => Array.isArray(calls) && calls.length === 3 &&
  calls.every((n) => Number.isInteger(n) && (enabled ? n > 0 : n === 0));
function selfTest() {
  assert.equal(median([3, 1, 2]), 2);
  assert.deepEqual(interval([-2, -2, -2, -2, -2]), [-2, -2]);
  assert.throws(() => interval([1]));
  assert.ok(sameManifest("hash  one\n", "hash  one\n"));
  assert.ok(!sameManifest("hash  one\n", "changed  one\n"));
  assert.ok(!sameManifest("hash  one\n", "hash  two\n"));
  assert.ok(!sameManifest("hash  one\n", ""));
  assert.ok(validHookCalls([1, 2, 3], true));
  assert.ok(!validHookCalls([0, 0, 0], true));
  assert.ok(validHookCalls([0, 0, 0], false));
  assert.ok(!validHookCalls([0, 1, 0], false));
}
selfTest();
if (process.argv.includes("--self-test")) {
  console.log("measurement controls passed");
  process.exit(0);
}

const workspace = process.env.GITHUB_WORKSPACE;
if (!workspace) throw new Error("GITHUB_WORKSPACE is required");
const data = path.join(workspace, "bench-data");
const scripts = path.join(workspace, ".github", "scripts", "pack-v230");
const resultDir = path.join(data, "results");
const measureDir = path.join(data, "measure");
const pack = path.join(data, "pack");
fs.mkdirSync(resultDir, { recursive: true });
fs.mkdirSync(measureDir, { recursive: true });
for (const f of ["gen-watch.cjs", "watch-mem4.cjs"]) {
  fs.copyFileSync(path.join(scripts, f), path.join(measureDir, f));
}
fs.writeFileSync(path.join(measureDir, "package.json"), '{"private":true}\n');
function command(name, args, options = {}) {
  const r = spawnSync(name, args, { cwd: measureDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0) throw new Error(`${name} failed: ${r.error || r.signal || r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}
const core = path.join(pack, "rspack-core-2.3.0.tgz");
const native = path.join(pack, "rspack.linux-x64-gnu.node");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const identity = sha(native);
const install = command("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", core]);
fs.writeFileSync(path.join(resultDir, "measure-install.log"), `${install.stdout}${install.stderr}`);
const unpacked = path.join(data, "measure-core-check");
fs.mkdirSync(unpacked, { recursive: true });
command("tar", ["-xzf", core, "-C", unpacked]);
const installedJs = fs.readFileSync(path.join(measureDir, "node_modules", "@rspack", "core", "dist", "index.js"));
if (!installedJs.equals(fs.readFileSync(path.join(unpacked, "package", "dist", "index.js")))) {
  throw new Error("installed core does not match the packed core");
}
const generator = command(process.execPath, ["gen-watch.cjs"], { env: { ...process.env, ROUTES: "3000" } });
fs.writeFileSync(path.join(resultDir, "fixture.txt"), generator.stdout);
const runs = Number(process.env.RUNS || 5);
if (!Number.isInteger(runs) || runs < 5) throw new Error("at least five pairs are required");
const tapEnabled = process.env.MEASURE_ASSET_EMITTED_TAP !== "off";
const diagnosticEnv = { ...process.env, ROUTES: "3000", NAPI_RS_NATIVE_LIBRARY_PATH: native, EXPECT_SHA: identity, RSPACK_EMITTED_SOURCES: "size-only", ASSET_SIZE_DIAGNOSTIC: "1" };
const diagnostic = spawnSync(process.execPath, ["watch-mem4.cjs", "diagnostic"], {
  cwd: measureDir, env: diagnosticEnv, encoding: "utf8", timeout: 900000, maxBuffer: 16 * 1024 * 1024,
});
fs.writeFileSync(path.join(resultDir, "asset-bytes.log"), `${diagnostic.stdout || ""}${diagnostic.stderr || ""}`);
if (diagnostic.error || diagnostic.status !== 0) throw new Error(`asset-byte diagnostic failed: ${diagnostic.error || diagnostic.signal || diagnostic.status}`);
const byteLines = (diagnostic.stdout || "").split("\n").filter((line) => line.startsWith("ASSET_BYTES="));
if (byteLines.length !== 1) throw new Error("asset-byte diagnostic did not report exactly once");
const assetBytes = JSON.parse(byteLines[0].slice("ASSET_BYTES=".length));
if (assetBytes.map_count < 1 || assetBytes.other_count < 1 || assetBytes.map_bytes < 1 || assetBytes.other_bytes < 1) {
  throw new Error("asset-byte diagnostic reported empty categories");
}
const diagnosticMeasures = (diagnostic.stdout || "").split("\n").filter((line) => line.startsWith("MEASURE="));
if (diagnosticMeasures.length !== 1) throw new Error("asset-byte diagnostic has no unique output count");
const diagnosticFiles = JSON.parse(diagnosticMeasures[0].slice("MEASURE=".length)).files;
if (assetBytes.map_count + assetBytes.other_count !== diagnosticFiles) throw new Error("asset-byte and output counts differ");
fs.writeFileSync(path.join(resultDir, "asset-bytes.json"), `${JSON.stringify(assetBytes, null, 2)}\n`);
fs.mkdirSync(path.join(resultDir, "manifests"), { recursive: true });
const samples = { off: [], on: [] };
let reference;
for (let pair = 1; pair <= runs; pair++) {
  const order = pair % 2 ? ["off", "on"] : ["on", "off"];
  for (const arm of order) {
    const env = { ...process.env, ROUTES: "3000", NAPI_RS_NATIVE_LIBRARY_PATH: native, EXPECT_SHA: identity };
    delete env.ASSET_SIZE_DIAGNOSTIC;
    if (arm === "on") env.RSPACK_EMITTED_SOURCES = "size-only";
    else delete env.RSPACK_EMITTED_SOURCES;
    const label = `${arm}-${pair}`;
    const r = spawnSync(process.execPath, ["watch-mem4.cjs", label], {
      cwd: measureDir, env, encoding: "utf8", timeout: 900000, maxBuffer: 16 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(resultDir, `${label}.log`), `${r.stdout || ""}${r.stderr || ""}`);
    if (r.error || r.status !== 0) throw new Error(`${label} failed; not a sample: ${r.error || r.signal || r.status}`);
    const lines = (r.stdout || "").split("\n").filter((line) => line.startsWith("MEASURE="));
    if (lines.length !== 1) throw new Error(`${label} has no unique measurement`);
    const sample = JSON.parse(lines[0].slice("MEASURE=".length));
    if (sample.binding !== identity || sample.rebuild_ms.length !== 2 || sample.edit_kib.length !== 2 ||
        !validHookCalls(sample.hook_calls, tapEnabled)) {
      throw new Error(`${label} has invalid identity, edit count, or assetEmitted coverage`);
    }
    for (const x of [sample.build_ms, sample.cold_kib, sample.peak_kib, ...sample.rebuild_ms, ...sample.edit_kib]) {
      if (!Number.isFinite(x) || x <= 0) throw new Error(`${label} has an invalid measurement`);
    }
    const manifest = fs.readFileSync(path.join(measureDir, "results", `watch-${label}.txt`), "utf8");
    reference ??= manifest;
    if (!sameManifest(reference, manifest)) throw new Error(`${label} output differs or is missing`);
    fs.writeFileSync(path.join(resultDir, "manifests", `${label}.txt`), manifest);
    samples[arm].push({ pair, ...sample });
    fs.writeFileSync(path.join(resultDir, "samples.json"), JSON.stringify(samples, null, 2));
  }
}
const metrics = [
  ["cold_rss_mib", (x) => x.cold_kib / 1024],
  ["peak_rss_mib", (x) => x.peak_kib / 1024],
  ["edit1_rss_mib", (x) => x.edit_kib[0] / 1024],
  ["edit2_rss_mib", (x) => x.edit_kib[1] / 1024],
  ["build_ms", (x) => x.build_ms],
  ["rebuild1_ms", (x) => x.rebuild_ms[0]],
  ["rebuild2_ms", (x) => x.rebuild_ms[1]],
];
const summary = [
  `platform=${process.platform} arch=${process.arch} kernel=${os.release()} node=${process.version}`,
  `native_sha256=${identity} core_sha256=${sha(core)} pairs=${runs} routes=3000 edits=2`,
  `output_parity=identical files=${samples.off[0].files}`,
  `asset_emitted_tap=${tapEnabled ? "both-arms synchronous-size-only no-retention" : "none"}`,
  `cold_asset_map_bytes=${assetBytes.map_bytes} map_count=${assetBytes.map_count} other_bytes=${assetBytes.other_bytes} other_count=${assetBytes.other_count}`,
  "metric off_median on_median paired_delta_median interval95_low interval95_high",
];
let slow = false;
for (const [name, value] of metrics) {
  const off = samples.off.map(value);
  const on = samples.on.map(value);
  if (samples.off.some((x, i) => x.pair !== samples.on[i].pair)) throw new Error("unpaired samples");
  const deltas = on.map((x, i) => x - off[i]);
  const [low, high] = interval(deltas);
  summary.push(`${name} ${median(off).toFixed(2)} ${median(on).toFixed(2)} ${median(deltas).toFixed(2)} ${low.toFixed(2)} ${high.toFixed(2)}`);
  if (name.endsWith("_ms") && low > 0) slow = true;
}
const editDrop = [0, 1].every((i) => median(samples.on.map((x, pair) => x.edit_kib[i] - samples.off[pair].edit_kib[i])) < 0);
summary.push(`edit_rss_paired_median_lower=${editDrop}`);
summary.push(`time_regression_beyond_noise=${slow}`);
fs.writeFileSync(path.join(resultDir, "summary.txt"), `${summary.join("\n")}\n`);
console.log(summary.join("\n"));
if (slow) process.exitCode = 1;
