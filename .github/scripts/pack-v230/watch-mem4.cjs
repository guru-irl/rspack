// Measure one watch build and two edits; use the same fixture and output path for both arms.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sample = process.argv[2];
if (!sample) throw new Error("sample name is required");
const routes = Number(process.env.ROUTES || 3000);
if (!Number.isInteger(routes) || routes < 1) throw new Error("invalid route count");
const root = __dirname;
const { rspack, sources } = require("@rspack/core");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const loaded = [...new Set(process.report.getReport().sharedObjects.filter(
  (p) => p.toLowerCase().endsWith(".node") && p.toLowerCase().includes("rspack"),
))];
if (loaded.length !== 1 || sha(loaded[0]) !== process.env.EXPECT_SHA) {
  throw new Error(`unexpected native binding: ${JSON.stringify(loaded)}`);
}
const fixture = path.join(root, "watchfx");
const stamp = path.join(fixture, "src", "stamp.js");
fs.writeFileSync(stamp, "export const stamp = 0;\n");
const past = new Date(Date.now() - 120000);
(function backdate(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    if (item.isDirectory()) backdate(p);
    fs.utimesSync(p, past, past);
  }
})(fixture);
const out = path.join(root, "dist-watch", "same");
const compiler = rspack({
  context: fixture,
  mode: "development",
  devtool: "cheap-module-source-map",
  entry: "./src/index.js",
  output: { path: out, clean: true },
  infrastructureLogging: { level: "error" },
  performance: false,
  stats: "errors-warnings",
});
let hookCalls = 0;
if (process.env.MEASURE_ASSET_EMITTED_TAP !== "off") {
  compiler.hooks.assetEmitted.tap("measure-asset-size", (_filename, info) => {
    const size = info.source.size();
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid emitted source size");
    hookCalls++;
  });
}
if (process.env.ASSET_SIZE_DIAGNOSTIC === "1") {
  let reported = false;
  compiler.hooks.afterEmit.tap("asset-size-diagnostic", (compilation) => {
    if (reported) return;
    reported = true;
    const totals = { map_bytes: 0, other_bytes: 0, map_count: 0, other_count: 0 };
    for (const asset of compilation.getAssets()) {
      const source = asset.source;
      if (!(source instanceof sources.SizeOnlySource)) throw new Error(`asset was not replaced: ${asset.name}`);
      if (asset.name.endsWith(".map")) {
        totals.map_bytes += source.size();
        totals.map_count++;
      } else {
        totals.other_bytes += source.size();
        totals.other_count++;
      }
    }
    console.log(`ASSET_BYTES=${JSON.stringify(totals)}`);
  });
}
const seen = new Set();
compiler.hooks.watchRun.tap("measure", (c) => {
  for (const f of c.modifiedFiles || []) seen.add(f);
});
const t0 = Date.now();
let phase = "cold";
let edit = 0;
let editStart = 0;
const result = { build_ms: 0, cold_kib: 0, rebuild_ms: [], edit_kib: [], peak_kib: 0, hook_calls: [] };
const rss = () => Math.round(process.memoryUsage().rss / 1024);
const watching = compiler.watch({ aggregateTimeout: 50 }, (error, stats) => {
  if (error || !stats || stats.hasErrors()) {
    console.error(error || stats?.toString("errors-only") || "missing stats");
    process.exit(2);
  }
  result.hook_calls.push(hookCalls);
  hookCalls = 0;
  if (phase === "cold") {
    result.build_ms = Date.now() - t0;
    phase = "idle";
    setTimeout(() => {
      result.cold_kib = rss();
      nextEdit();
    }, 1000);
    return;
  }
  if (phase !== "rebuilding" || !seen.has(stamp)) {
    console.error(`unexpected rebuild during ${phase}`);
    process.exit(4);
  }
  result.rebuild_ms.push(Date.now() - editStart);
  phase = "idle";
  setTimeout(() => {
    result.edit_kib.push(rss());
    if (edit < 2) nextEdit();
    else finish();
  }, 1000);
});
function nextEdit() {
  edit++;
  seen.clear();
  phase = "rebuilding";
  editStart = Date.now();
  fs.writeFileSync(stamp, `export const stamp = ${edit};\n`);
}
function finish() {
  phase = "finished";
  result.peak_kib = process.resourceUsage().maxRSS;
  watching.close(() => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const p = path.join(dir, item.name);
      return item.isDirectory() ? walk(p) : [p];
    });
    const lines = walk(out).map((p) => `${sha(p)}  ${path.relative(out, p).split(path.sep).join("/")}`).sort();
    if (lines.length < 2 * (routes + 1)) throw new Error(`too few emitted files: ${lines.length}`);
    fs.mkdirSync(path.join(root, "results"), { recursive: true });
    fs.writeFileSync(path.join(root, "results", `watch-${sample}.txt`), lines.join("\n") + "\n");
    console.log(`MEASURE=${JSON.stringify({ ...result, files: lines.length, binding: sha(loaded[0]) })}`);
    process.exit(0);
  });
}
setTimeout(() => {
  console.error(`watch timeout in phase ${phase}`);
  process.exit(3);
}, 900000).unref();
