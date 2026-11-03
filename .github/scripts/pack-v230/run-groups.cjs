// Usage: node run-groups.cjs <arm>
// Proves the loaded binding via /proc/self/maps (EXPECT_SHA), builds the synthetic fixture once in
// development mode, and writes results/groups-<arm>.txt with one "<sha256>  <path>" line per file.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const [arm] = process.argv.slice(2);
const root = __dirname;
const { rspack } = require("@rspack/core");

const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const loaded = [...new Set(fs.readFileSync("/proc/self/maps", "utf8").split("\n")
  .map(l => l.trim().split(/\s+/).slice(5).join(" "))
  .filter(p => p.endsWith(".node") && p.includes("rspack")))];
if (loaded.length !== 1) { console.error(`binding proof failed: ${JSON.stringify(loaded)}`); process.exit(91); }
const loadedSha = sha(loaded[0]);
if (process.env.EXPECT_SHA && process.env.EXPECT_SHA !== loadedSha) { console.error("binding sha mismatch"); process.exit(91); }

const out = path.join(root, "dist-groups", arm);
const t0 = Date.now();
const compiler = rspack({
  context: path.join(root, "groups"),
  mode: "development",
  devtool: false,
  entry: "./src/index.js",
  output: { path: out, clean: true },
  cache: false,
  infrastructureLogging: { level: "error" },
  performance: false,
  stats: "errors-warnings",
});
compiler.run((err, stats) => {
  if (err || stats.hasErrors() || stats.hasWarnings()) {
    console.error(err || stats.toString("errors-warnings"));
    process.exit(2);
  }
  const ms = Date.now() - t0;
  const chunks = stats.compilation.chunks.size;
  compiler.close(() => {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const lines = walk(out).map(p => `${sha(p)}  ${path.relative(out, p)}`).sort();
    fs.mkdirSync(path.join(root, "results"), { recursive: true });
    fs.writeFileSync(path.join(root, "results", `groups-${arm}.txt`), lines.join("\n") + "\n");
    console.log(`[${arm}] binding ${loadedSha} chunks=${chunks} files=${lines.length} build_ms=${ms}`);
    process.exit(0);
  });
});
