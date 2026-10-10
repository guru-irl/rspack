'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { rspack, rspackVersion } = require('@rspack/core');
const [rootArg, resultArg, arm, roundArg] = process.argv.slice(2);
const root = fs.realpathSync(rootArg);
const result = path.resolve(resultArg);
const round = Number(roundArg);
const ids = { DD: ['deterministic', 'deterministic'], DD2: ['deterministic', 'deterministic'], DN: ['deterministic', 'named'], ND: ['named', 'deterministic'], NN: ['named', 'named'] }[arm];
assert(ids);
assert.equal(rspackVersion, '2.2.8');
const leaf = path.join(root, 'src/route0/leaf0.js');
const cachePath = path.join(root, 'cache');
fs.rmSync(cachePath, { recursive: true, force: true });
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.writeFileSync(leaf, 'export default "ids-benchmark-edit-initial";\n');
let pending = null;
let invalidStart = null;
let watchRunStart = null;
let doneMetrics = null;
let step = 0;
let settlingCallbacks = 0;
const rows = [];
const cacheGroups = Object.fromEntries([0, 1, 2, 3].map(g => [`shared${g}`, {
  test: new RegExp(`[\\\\/]shared${g}[\\\\/]`), name: `shared${g}`, chunks: 'all', minChunks: 2, minSize: 0, enforce: true, priority: 10 - g,
}]));
const compiler = rspack({
  mode: 'development', context: root, entry: './src/index.js', target: 'web', devtool: false,
  cache: { type: 'persistent', storage: { type: 'filesystem', directory: cachePath } },
  incremental: { silent: false }, experiments: { newCache: false, nativeWatcher: false, css: true },
  module: { rules: [{ test: /\.js$/, use: [path.join(root, 'loader.cjs')] }, { test: /\.css$/, type: 'css' }] },
  optimization: { moduleIds: ids[0], chunkIds: ids[1], runtimeChunk: false,
    concatenateModules: false, minimize: false, usedExports: false, mangleExports: false, inlineExports: false,
    splitChunks: { chunks: 'all', minSize: 0, maxAsyncRequests: Infinity, maxInitialRequests: Infinity,
      cacheGroups: { default: false, defaultVendors: false, ...cacheGroups } } },
  output: { path: path.join(root, 'dist'), filename: '[name].js', chunkFilename: '[id].js', cssFilename: '[name].css', cssChunkFilename: '[id].css', clean: false },
  infrastructureLogging: { level: 'warn' },
  plugins: [{ apply(c) {
    c.hooks.invalid.tap('IdsBenchmark', filename => {
      console.error(JSON.stringify({ invalidatedFile: filename, step, pending }));
      assert(filename && fs.realpathSync(filename) === leaf, `Unexpected invalidated file: ${filename}`);
      if (!pending) {
        clearTimeout(editTimer);
        assert(++settlingCallbacks <= 20, 'Watchpack did not settle');
        return;
      }
      assert.equal(invalidStart, null, 'Multiple invalidations for one edit');
      invalidStart = { at: performance.now(), cpu: process.cpuUsage() };
    });
    c.hooks.watchRun.tap('IdsBenchmark', () => { watchRunStart = performance.now(); });
    c.hooks.done.tap('IdsBenchmark', () => {
      const at = performance.now();
      doneMetrics = { wallMs: invalidStart ? at - invalidStart.at : null,
        watchRunMs: at - watchRunStart, cpu: invalidStart ? process.cpuUsage(invalidStart.cpu) : null,
        peakRssMiB: process.resourceUsage().maxRSS / 1024, steadyRssMiB: process.memoryUsage().rss / 1048576 };
    });
  } }],
});

function count(logging, pass) {
  const text = (logging[`rspack.incremental.${pass}`]?.entries || []).map(e => e.message).join('\n');
  const m = text.match(/(\d+) (?:modules|chunks) are affected, (\d+) in total/);
  return m ? { affected: Number(m[1]), total: Number(m[2]), provenance: 'incremental logger' } : null;
}
function phaseTimes(logging) {
  return Object.fromEntries((logging['rspack.Compilation']?.entries || []).filter(e => e.type === 'time').map(e => {
    const m = e.message.match(/^(.*): ([\d.]+) ms$/);
    assert(m, `Unparsed time: ${e.message}`);
    return [m[1], Number(m[2])];
  }));
}

let watching;
let editTimer;
function scheduleEdit() {
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    pending = `ids-benchmark-edit-${arm}-${round}-${step}`;
    fs.writeFileSync(leaf, `export default "${pending}";\n`);
  }, 1200);
}
const timeout = setTimeout(() => { console.error('Benchmark process timed out'); process.exit(1); }, 20 * 60 * 1000);
watching = compiler.watch({ aggregateTimeout: 20, poll: 100 }, (err, stats) => {
  try {
    if (err) throw err;
    assert(stats && !stats.hasErrors(), stats?.toString({ all: false, errors: true }));
    if (step > 0 && !pending) {
      console.log(JSON.stringify({ unmeasuredSettlingCallback: true, step }));
      invalidStart = null;
      scheduleEdit();
      return;
    }
    assert(step === 0 || invalidStart, 'No invalid hook for requested edit');
    const json = stats.toJson({ all: false, errors: true, warnings: true, logging: 'verbose', loggingDebug: /rspack\.incremental/ });
    const logging = json.logging || {};
    const times = phaseTimes(logging);
    for (const phase of ['create module hashes', 'code generation', 'hashing', 'module ids', 'chunk ids']) assert(Number.isFinite(times[phase]), `Missing phase ${phase}`);
    const compilation = stats.compilation;
    const modules = [...compilation.modules].filter(m => m.resource);
    const edited = modules.find(m => m.resource === leaf);
    assert(edited, 'Edited module missing');
    const expected = pending || 'ids-benchmark-edit-initial';
    assert(edited.originalSource().source().toString().includes(expected), 'Original source is stale');
    const editedChunks = [...compilation.chunkGraph.getModuleChunksIterable(edited)];
    const outputObserved = editedChunks.some(chunk => [...chunk.files].filter(name => name.endsWith('.js')).some(name => compilation.getAsset(name).source.source().toString().includes(expected)));
    assert(outputObserved, 'Generated source is stale');
    const totalModules = modules.length;
    const totalChunks = compilation.chunks.size;
    const warnings = (json.warnings || []).map(w => w.message);
    const hashes = count(logging, 'modulesHashes');
    const codegen = count(logging, 'modulesCodegen');
    const chunkHashes = count(logging, 'chunksHashes');
    fs.mkdirSync(path.dirname(result), { recursive: true });
    fs.writeFileSync(`${result}.latest-stats.json`, JSON.stringify({ step, totalModules, totalChunks, hashes, codegen, chunkHashes, warnings, logging }, null, 2));
    if (step > 0) {
      assert(codegen, 'Missing codegen affected count');
      if (arm === 'NN') assert(hashes && hashes.affected < totalModules / 2 && codegen.affected < totalModules / 2, `Named arm is not incremental: ${JSON.stringify({ hashes, codegen, warnings })}`);
      else {
        assert(warnings.some(w => /modulesHashes/.test(w)), 'Missing deterministic hash fallback warning');
        assert.equal(codegen.affected, totalModules, 'Deterministic arm did not select full graph');
      }
    }
    const row = { step, measured: step >= 3, expected, editValidated: true, ...doneMetrics,
      userMs: doneMetrics.cpu ? doneMetrics.cpu.user / 1000 : null,
      sysMs: doneMetrics.cpu ? doneMetrics.cpu.system / 1000 : null,
      totalModules, totalChunks, phases: times,
      moduleHashes: hashes || (step > 0 && warnings.some(w => /modulesHashes/.test(w)) ? { affected: totalModules, total: totalModules, provenance: 'full selection inferred from fallback and pinned public source' } : null),
      moduleCodegen: codegen, chunkHashes,
      codegenCache: (logging['rspack.Compilation']?.entries || []).filter(e => e.type === 'cache' && e.message.startsWith('module code generation cache')).map(e => e.message), warnings, logging };
    rows.push(row);
    console.log(JSON.stringify({ arm, round, step, measured: row.measured, wallMs: row.wallMs, phases: times, totalModules, totalChunks, moduleHashes: row.moduleHashes, moduleCodegen: codegen, chunkHashes, warnings }));
    step++;
    if (step <= 5) {
      pending = null;
      invalidStart = null;
      scheduleEdit();
    } else {
      clearTimeout(timeout);
      clearTimeout(editTimer);
      watching.close(() => compiler.close(closeErr => {
        if (closeErr) { console.error(closeErr); process.exitCode = 1; return; }
        const data = { arm, ids, round, metadata: { node: process.version, rspack: rspackVersion, cli: require('@rspack/cli/package.json').version,
          os: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, cpu: os.cpus()[0].model,
          totalMemoryMiB: os.totalmem() / 1048576, loadAverage: os.loadavg(), timestamp: new Date().toISOString(),
          settlingCallbacks, cache: 'legacy persistent; empty disk cache for each process; in-process warmup',
          watcher: 'Watchpack polling 100 ms; aggregateTimeout 20 ms', peakRssMiB: process.resourceUsage().maxRSS / 1024 }, rows };
        fs.mkdirSync(path.dirname(result), { recursive: true });
        fs.writeFileSync(result, JSON.stringify(data, null, 2));
      }));
    }
  } catch (e) { console.error(e); clearTimeout(timeout); clearTimeout(editTimer); process.exit(1); }
});
