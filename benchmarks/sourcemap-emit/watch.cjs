'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { moduleText, generate } = require('./generate.cjs');
const root = path.resolve(process.env.STUDY_ROOT);
const results = path.resolve(process.env.STUDY_RESULTS);
fs.mkdirSync(results, { recursive: true });
const arm = process.env.STUDY_ARM || 'memfs';
const label = process.env.STUDY_LABEL || 'baseline';
const edits = Number(process.env.STUDY_EDITS || 6);
const count = Number(process.env.STUDY_MODULES || 30000);
const { rspack } = require(process.env.STUDY_CORE);
const { Volume, createFsFromVolume } = require(process.env.STUDY_MEMFS);
if (!fs.existsSync(path.join(root, 'entry.js'))) generate(root, count);
const edited = path.join(root, 'modules', 'm15000.js');
fs.writeFileSync(edited, moduleText(15000, 0));
const output = path.join(root, 'dist');
const ofs = arm === 'memfs' ? createFsFromVolume(new Volume()) : Object.create(fs);
ofs.join = path.join.bind(path);
let row;
for (const op of ['writeFile', 'readFile', 'stat', 'mkdir', 'unlink', 'rmdir']) {
  const fn = ofs[op].bind(ofs);
  ofs[op] = (...args) => {
    const start = performance.now();
    const callback = args.pop();
    const name = String(args[0]);
    return fn(...args, (...res) => {
      if (row) row.fs.push({ op, name: path.basename(name), ms: performance.now() - start, bytes: op === 'writeFile' ? args[1].length : op === 'readFile' && !res[0] ? res[1].length : 0 });
      callback(...res);
    });
  };
}
const plugin = { apply(compiler) {
  compiler.hooks.compile.tap('Study', () => { row = { label, arm, edit: -1, fs: [], content: [], stage: {}, start: performance.now() }; console.log('STUDY_BEGIN'); });
  compiler.hooks.thisCompilation.tap('Study', compilation => {
    for (const [name, stage] of [['begin', -10000], ['beforeMap', 499], ['afterMap', 501], ['end', 10000]]) {
      compilation.hooks.processAssets.tap({ name: `Study:${name}`, stage }, () => { row.stage[name] = performance.now(); });
    }
  });
  compiler.hooks.emit.tap('Study', () => { row.emitStart = performance.now(); });
  compiler.hooks.afterEmit.tap('Study', () => { row.emitEnd = performance.now(); });
  compiler.hooks.assetEmitted.tap('Study:middleware', (file, info) => {
    const start = performance.now();
    // Emulates a listener that reads the dev-middleware content snapshot, without retaining it.
    if (process.env.STUDY_LISTENER !== 'metadata') {
      const content = info.content;
      row.content.push({ file, bytes: content.length, ms: performance.now() - start });
    }
  });
} };
const compiler = rspack({
  context: root, mode: 'development', target: 'node', devtool: 'cheap-module-source-map',
  entry: { app: './entry.js' },
  output: { path: output, filename: '[name].js', chunkFilename: '[name].js', library: { type: 'commonjs' }, clean: false },
  optimization: { minimize: false, concatenateModules: false, runtimeChunk: 'single', splitChunks: { chunks: 'all', cacheGroups: { default: false, defaultVendors: false, shared: { test: /[\\/]modules[\\/]/, name: 'shared', enforce: true, chunks: 'all' } } } },
  plugins: [plugin], infrastructureLogging: { level: 'error' }, stats: 'errors-warnings',
});
compiler.outputFileSystem = ofs;
let step = 0;
let watcher;
const hashes = [];
const timer = setTimeout(() => { console.error('Watch study timed out'); process.exit(2); }, 30 * 60 * 1000);
watcher = compiler.watch({ aggregateTimeout: 30 }, async (err, stats) => {
  try {
    if (err) throw err;
    if (stats.hasErrors()) throw new Error(stats.toString('errors-only'));
    row.edit = step;
    row.totalMs = performance.now() - row.start;
    row.processAssetsMs = row.stage.end - row.stage.begin;
    row.mapPluginMs = row.stage.afterMap - row.stage.beforeMap;
    row.emitMs = row.emitEnd - row.emitStart;
    row.rssEnd = process.memoryUsage().rss;
    console.log('STUDY_END ' + JSON.stringify({ edit: step, rss: row.rssEnd }));
    if (global.gc) global.gc();
    row.rssEndGc = process.memoryUsage().rss;
    // Hash output AFTER timings, streaming disk bytes. Memfs readFile copies are excluded too.
    const digest = {};
    for (const name of ofs.readdirSync(output).sort()) {
      const bytes = ofs.readFileSync(path.join(output, name));
      digest[name] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
    hashes.push({ edit: step, files: digest });
    fs.appendFileSync(path.join(results, `${label}-${arm}.jsonl`), JSON.stringify(row) + '\n');
    fs.writeFileSync(path.join(results, `${label}-${arm}-hashes.json`), JSON.stringify(hashes, null, 2));
    if (step === 0) {
      const bundle = digest['shared.js'].bytes;
      const map = digest['shared.js.map'].bytes;
      if (count === 30000 && (bundle < 100e6 || map < 100e6 || bundle > 160e6 || map > 170e6)) throw new Error(`Fixture size outside intended range: ${bundle}, ${map}`);
    }
    if (global.gc) global.gc();
    if (step >= edits) {
      clearTimeout(timer);
      watcher.close(error => compiler.close(closeError => { if (error || closeError) { console.error(error || closeError); process.exitCode = 1; } }));
    } else {
      step++;
      // True filesystem-triggered watch rebuild, not compiler.run or invalidate-only rebuilding.
      setTimeout(() => fs.writeFileSync(edited, moduleText(15000, step)), 100);
    }
  } catch (error) { console.error(error); process.exit(1); }
});
