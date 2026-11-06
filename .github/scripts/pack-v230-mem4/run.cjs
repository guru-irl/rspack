const fs = require("fs");
const path = require("path");
const { rspack } = require("@rspack/core");

const resultPath = process.argv[2];
if (!resultPath || !process.env.EXPECT_LIBRARY) throw new Error("result path and EXPECT_LIBRARY are required");
const expected = fs.realpathSync(process.env.EXPECT_LIBRARY);
const mapped = [...new Set(fs.readFileSync("/proc/self/maps", "utf8").split("\n")
  .map(line => line.trim().split(/\s+/).slice(5).join(" "))
  .filter(file => file.endsWith(".node") && file.includes("rspack"))
  .map(file => fs.realpathSync(file)))];
if (mapped.length !== 1 || mapped[0] !== expected) throw new Error(`unexpected native binding: ${JSON.stringify(mapped)}`);
console.log(`loaded binding ${mapped[0]}`);

const work = path.join(__dirname, "work", "same");
const out = path.join(work, "dist");
const config = {
  context: work,
  entry: "./src/index.js",
  mode: "development",
  devtool: "source-map",
  cache: { type: "memory" },
  output: { path: out, filename: "bundle.js", clean: true },
  performance: false,
  infrastructureLogging: { level: "error" },
  stats: "errors-warnings",
};

function flattened(entries) {
  return entries.flatMap(entry => [entry, ...flattened(entry.children || [])]);
}
function timing(logging, origin, label) {
  const log = logging[origin];
  if (!log) throw new Error(`missing log origin ${origin}; got ${Object.keys(logging)}`);
  const prefix = `${label}: `;
  const values = flattened(log.entries).filter(entry => entry.type === "time" && entry.message.startsWith(prefix));
  if (values.length !== 1) throw new Error(`expected one ${origin}/${label} timer, got ${JSON.stringify(values)}`);
  const match = values[0].message.match(/: ([0-9.]+) ms$/);
  if (!match) throw new Error(`unexpected timer ${values[0].message}`);
  return Number(match[1]);
}
function readPasses(stats) {
  const data = stats.toJson({ all: false, logging: "verbose", loggingTrace: false, timings: true });
  if (!data.logging || typeof data.time !== "number") throw new Error("missing compilation timings");
  return {
    stats_ms: data.time,
    codegen_ms: timing(data.logging, "rspack.Compilation", "code generation"),
    render_ms: timing(data.logging, "rspack.Compilation", "create chunk assets"),
    process_assets_ms: timing(data.logging, "rspack.Compilation", "process assets"),
    devtool_collect_ms: timing(data.logging, "rspack.SourceMapDevToolPlugin", "collect source maps"),
    devtool_emit_ms: timing(data.logging, "rspack.SourceMapDevToolPlugin", "emit source map assets"),
    emit_ms: timing(data.logging, "rspack.Compiler", "emitAssets"),
  };
}

const builds = [];
let started = process.hrtime.bigint();
const compiler = rspack(config);
const timeout = setTimeout(() => { console.error("watch timed out"); process.exit(3); }, 600000);
timeout.unref();
const watching = compiler.watch({ aggregateTimeout: 50 }, (err, stats) => {
  try {
    if (err || !stats || stats.hasErrors() || stats.hasWarnings()) {
      throw err || new Error(stats ? stats.toString("errors-warnings") : "missing stats");
    }
    const elapsed_ms = Number(process.hrtime.bigint() - started) / 1e6;
    const memory = process.memoryUsage();
    const sizes = {
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      external_bytes: memory.external,
      array_buffers_bytes: memory.arrayBuffers,
    };
    const passes = readPasses(stats);
    builds.push({ elapsed_ms, ...sizes, ...passes });
    console.log(JSON.stringify({ build: builds.length - 1, elapsed_ms, ...sizes, ...passes }));
    if (builds.length < 3) {
      const edit = builds.length;
      setTimeout(() => {
        started = process.hrtime.bigint();
        fs.appendFileSync(path.join(work, "src", "index.js"), `\nglobalThis.edit${edit} = ${edit};\n`);
      }, 200);
    } else {
      watching.close(closeError => {
        if (closeError) { console.error(closeError); process.exit(4); }
        fs.writeFileSync(resultPath, JSON.stringify({ binding: mapped[0], builds }) + "\n");
        process.exit(0);
      });
    }
  } catch (error) {
    console.error(error && error.stack || error);
    process.exit(2);
  }
});
