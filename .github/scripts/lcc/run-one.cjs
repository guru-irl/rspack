// Builds a generated fixture once with the binding in NAPI_RS_NATIVE_LIBRARY_PATH.
// Usage: node run-one.cjs <repo root> <fixture dir> <output dir> '<options json>'
// Prints one JSON result line on stdout. The binding prints its own stats line on stderr.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const [repoRoot, fixtureDir, outDir, optionsJson] = process.argv.slice(2);
const options = JSON.parse(optionsJson);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function mappedBinding() {
  return fs
    .readFileSync("/proc/self/maps", "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/).pop())
    .find((file) => file?.endsWith(".node") && file.includes("rspack"));
}

let afterOptimizeModules = 0n;
let optimizeChunksMs = null;
class Timing {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap("Timing", (compilation) => {
      compilation.hooks.afterOptimizeModules.tap("Timing", () => {
        afterOptimizeModules = process.hrtime.bigint();
      });
      compilation.hooks.optimizeTree.tap("Timing", () => {
        optimizeChunksMs = Number(process.hrtime.bigint() - afterOptimizeModules) / 1e6;
      });
    });
  }
}

async function main() {
  const { rspack } = await import(
    pathToFileURL(path.join(repoRoot, "packages/rspack/dist/index.js")).href
  );

  const limit = { maxChunks: options.maxChunks };
  if (options.chunkOverhead !== undefined) limit.chunkOverhead = options.chunkOverhead;
  if (options.entryChunkMultiplicator !== undefined) {
    limit.entryChunkMultiplicator = options.entryChunkMultiplicator;
  }

  const optimization = { minimize: false };
  if (!options.splitChunks) optimization.splitChunks = false;

  const compiler = rspack({
    mode: "production",
    context: fixtureDir,
    entry: options.secondEntry
      ? { main: "./src/index.js", other: "./src/other.js" }
      : { main: "./src/index.js" },
    output: {
      path: outDir,
      filename: "[name].js",
      chunkFilename: "[name].[contenthash:8].js",
      clean: true,
    },
    devtool: false,
    optimization,
    plugins: [new rspack.optimize.LimitChunkCountPlugin(limit), new Timing()],
    infrastructureLogging: { level: "error" },
  });

  const start = process.hrtime.bigint();
  compiler.run((error, stats) => {
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (error || stats.hasErrors()) {
      console.error(error ?? stats.toString({ all: false, errors: true }));
      process.exit(1);
    }
    const json = stats.toJson({ all: false, chunks: true, assets: true });
    const mapped = mappedBinding();
    if (!mapped || path.resolve(mapped) !== path.resolve(process.env.NAPI_RS_NATIVE_LIBRARY_PATH)) {
      console.error(`wrong binding mapped: ${mapped}`);
      process.exit(2);
    }
    compiler.close(() => {
      const files = fs
        .readdirSync(outDir, { recursive: true })
        .filter((file) => fs.statSync(path.join(outDir, file)).isFile())
        .sort()
        .map((file) => [file, sha256(path.join(outDir, file))]);
      const manifest = JSON.stringify(files);
      const status = fs.readFileSync("/proc/self/status", "utf8");
      console.log(
        JSON.stringify({
          wallMs,
          optimizeChunksMs,
          chunks: json.chunks.length,
          chunkNames: json.chunks.map((chunk) => chunk.names.join("+")).sort(),
          files: files.length,
          manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"),
          manifest: files,
          binding: mapped,
          bindingSha256: sha256(mapped),
          peakRssKiB: Number(/VmHWM:\s+(\d+)/.exec(status)[1]),
        }),
      );
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
