// Usage: node run.cjs <arm> <cold|warm|watch|prod|multi|child>
// multi: production build with three entries (three runtimes) and every shared module split out.
// Proves the loaded binding via /proc/self/maps (EXPECT_SHA), builds, and writes results/<arm>-<scenario>.txt
// with one "<sha256>  <relative path>" line per emitted file.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const [arm, scenario] = process.argv.slice(2);
const root = __dirname;
const work = path.join(root, "work", arm);
const { rspack } = require("@rspack/core");

const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const loaded = [...new Set(fs.readFileSync("/proc/self/maps", "utf8").split("\n")
  .map(l => l.trim().split(/\s+/).slice(5).join(" "))
  .filter(p => p.endsWith(".node") && p.includes("rspack")))];
if (loaded.length !== 1) { console.error(`binding proof failed: ${JSON.stringify(loaded)}`); process.exit(91); }
const loadedSha = sha(loaded[0]);
console.log(`[${arm}/${scenario}] binding ${loaded[0]} ${loadedSha}`);
if (process.env.EXPECT_SHA && process.env.EXPECT_SHA !== loadedSha) { console.error("binding sha mismatch"); process.exit(91); }

function config(kind, outDir) {
  const dev = kind === "dev";
  const multi = kind === "multi";
  return {
    context: work,
    mode: dev ? "development" : "production",
    entry: multi ? { a: "./src/index.ts", b: "./src/route-0.ts", c: "./src/route-1.ts" } : "./src/index.ts",
    ...(multi ? { optimization: { splitChunks: { chunks: "all", minSize: 0 } } } : {}),
    devtool: dev ? "cheap-module-source-map" : "source-map",
    output: { path: outDir, clean: true },
    resolve: { extensions: [".ts", ".js"] },
    module: { rules: [{ test: /\.ts$/, loader: "builtin:swc-loader", options: { jsc: { parser: { syntax: "typescript" } } }, type: "javascript/auto" }] },
    cache: dev ? { type: "persistent", storage: { type: "filesystem", directory: path.join(work, ".cache") } } : false,
    infrastructureLogging: { level: "error" },
    performance: false,
    stats: "errors-warnings",
  };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
function finish(outDir) {
  const lines = walk(outDir).map(p => `${sha(p)}  ${path.relative(outDir, p)}`).sort();
  fs.mkdirSync(path.join(root, "results"), { recursive: true });
  fs.writeFileSync(path.join(root, "results", `${arm}-${scenario}.txt`), lines.join("\n") + "\n");
  const maps = lines.filter(l => l.endsWith(".map")).length;
  console.log(`[${arm}/${scenario}] ${lines.length} files (${maps} maps) ${Date.now() - t0} ms`);
  process.exit(0);
}
function check(err, stats) {
  if (err || stats.hasErrors() || stats.hasWarnings()) {
    console.error(err || stats.toString("errors-warnings"));
    process.exit(2);
  }
}

const t0 = Date.now();
const out = path.join(root, "dist", arm, scenario);
if (scenario === "cold") fs.rmSync(path.join(work, ".cache"), { recursive: true, force: true });
setTimeout(() => { console.error(`[${arm}/${scenario}] timeout`); process.exit(3); }, 120000).unref();

if (scenario === "watch") {
  const compiler = rspack(config("dev", out));
  let n = 0, tEdit = 0;
  const watching = compiler.watch({ aggregateTimeout: 50 }, (err, stats) => {
    check(err, stats);
    n++;
    if (n === 1) {
      setTimeout(() => { tEdit = Date.now(); fs.appendFileSync(path.join(work, "src", "shared-3.ts"),
        `export const extra3 = ${JSON.stringify("édit 🚀 漢 3")};\n`); }, 300);
    } else if (n === 2) {
      console.log(`[${arm}/watch] rebuild_ms=${Date.now() - tEdit} rss_after_rebuild_kib=${Math.round(process.memoryUsage().rss / 1024)}`);
      watching.close(() => finish(out));
    }
  });
} else {
  const options = config(scenario === "prod" || scenario === "multi" ? scenario : "dev", out);
  if (scenario === "child") {
    options.plugins = [{
      apply(compiler) {
        compiler.hooks.thisCompilation.tap("child-parity", compilation => {
          compilation.hooks.processAssets.tapAsync("child-parity", (_assets, callback) => {
            const child = compiler.createChildCompiler(compilation, "child", 0, { filename: "child.js" }, [
              new compiler.rspack.EntryPlugin(work, "./src/route-0.ts", { name: "child" }),
            ]);
            child.runAsChild(error => callback(error));
          });
        });
      },
    }];
  }
  const compiler = rspack(options);
  compiler.run((err, stats) => {
    check(err, stats);
    compiler.close(() => finish(out));
  });
}
