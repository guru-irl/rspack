const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { rspack, rspackVersion } = require("@rspack/core");

if (rspackVersion !== "2.3.0") throw new Error(`unexpected version ${rspackVersion}`);
const expected = fs.realpathSync(require.resolve("@rspack/binding-linux-x64-gnu"));
const loaded = [...new Set(fs.readFileSync("/proc/self/maps", "utf8").split("\n")
  .map(line => line.trim().split(/\s+/).slice(5).join(" "))
  .filter(file => file.endsWith(".node") && file.includes("rspack"))
  .map(file => fs.realpathSync(file)))];
if (loaded.length !== 1 || loaded[0] !== expected) throw new Error(`unexpected binding ${JSON.stringify(loaded)}`);
const sha = crypto.createHash("sha256").update(fs.readFileSync(expected)).digest("hex");
if (sha !== process.env.EXPECT_NATIVE_SHA) throw new Error(`binding SHA mismatch ${sha}`);
const root = __dirname;
const compiler = rspack({
  context: root,
  mode: "development",
  target: "node",
  entry: "./entry.js",
  output: { path: path.join(root, "dist"), filename: "bundle.js", library: { type: "commonjs2" } },
  infrastructureLogging: { level: "error" },
  performance: false,
});
compiler.run((error, stats) => {
  if (error || !stats || stats.hasErrors() || stats.hasWarnings()) {
    console.error(error || (stats && stats.toString("errors-warnings")) || "missing stats");
    process.exitCode = 1;
  } else {
    const result = require(path.join(root, "dist", "bundle.js"));
    if (result.answer !== 42) throw new Error(`unexpected output ${JSON.stringify(result)}`);
    console.log(JSON.stringify({ version: rspackVersion, binding: expected, sha256: sha, answer: result.answer }));
  }
  compiler.close(closeError => { if (closeError) { console.error(closeError); process.exitCode = 1; } });
});
