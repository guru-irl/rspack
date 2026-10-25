const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { rspack } = require(path.resolve(process.env.CORE_ENTRY));
const root = path.resolve('bench-data/fixture');
const results = path.resolve(process.env.RESULT_DIR);
const file = path.join(root, 'src/g0/m0.js');
const original = fs.readFileSync(file);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const output = path.join(root, 'out');
fs.rmSync(output, { recursive: true, force: true });
globalThis.loaderCalls = { noop: 0, ast: 0, rewrite: 0 };
const compiler = rspack({
  mode: 'development', context: root, entry: './entry.js', target: 'node',
  experiments: { nativeWatcher: false },
  cache: false, devtool: 'cheap-module-source-map', incremental: { silent: false },
  output: { path: output, filename: '[name].cjs', chunkFilename: '[name].[id].cjs' },
  module: { rules: [
    { test: /\.ts$/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript' } } } } },
    { test: /[\\/]m\d*0\.js$/, use: path.join(root, 'ast.cjs') },
    { test: /[\\/]m(?:\d*(?:05|25|45|65|85)|5)\.js$/, use: path.join(root, 'rewrite.cjs') },
    { test: /\.[jt]s$/, enforce: 'post', use: { loader: path.join(root, 'noop.cjs'), options: { generic: true } } },
  ] },
  optimization: {
    minimize: false, concatenateModules: false, usedExports: false,
    moduleIds: 'deterministic', chunkIds: 'deterministic',
    splitChunks: {
      chunks: 'all', minSize: 0,
      cacheGroups: {
        default: false, defaultVendors: false,
        shared: {
          type: 'javascript/auto',
          test(module) { return /[\\/]src[\\/]g\d+[\\/]/.test(module.resource || ''); },
          name(module) {
            const group = (module.resource || '').match(/[\\/]g(\d+)[\\/]/);
            return group ? 'group-' + group[1] : 'shared';
          }, enforce: true, minChunks: 1,
        },
      },
    },
  },
});
const rearms = [];
const watchFileSystem = compiler.watchFileSystem;
const watch = watchFileSystem.watch;
watchFileSystem.watch = function(...args) {
  const before = this.watcher;
  const cpu = process.cpuUsage();
  const start = performance.now();
  const handle = watch.apply(this, args);
  const milliseconds = performance.now() - start;
  const used = process.cpuUsage(cpu);
  rearms.push({ cycle: rearms.length, milliseconds, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, reused: Boolean(before && this.watcher === before), files: this.watcher.fileWatchers.size, directories: this.watcher.directoryWatchers.size });
  return handle;
};
const manifests = [];
const builds = [];
let callbacks = 0;
let edits = 0;
let lastEdit;
let watching;
let scheduled;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function manifest(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(item => {
    const relative = prefix + item.name;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) return manifest(absolute, relative + '/');
    const bytes = fs.readFileSync(absolute);
    return [{ file: relative, bytes: bytes.length, sha256: hash(bytes) }];
  });
}
(async () => {
  try {
    await new Promise((resolve, reject) => {
      watching = compiler.watch({ aggregateTimeout: 30 }, (error, stats) => {
        try {
          if (error) throw error;
          assert(stats && !stats.hasErrors(), stats?.toString({ all: false, errors: true }));
          assert.equal(callbacks, edits, 'Every edit must rebuild exactly once');
          if (callbacks === 0) assert.equal(globalThis.loaderCalls.noop, 60701);
          manifests.push(manifest(output));
          builds.push({ build: callbacks, editToCallbackMs: lastEdit === undefined ? null : performance.now() - lastEdit, rss: process.memoryUsage().rss });
          callbacks++;
          scheduled = setTimeout(async () => {
            try {
              assert.equal(rearms.length, callbacks, 'Each delivered build must re-arm once');
              if (edits === 5) {
                await delay(500);
                assert.equal(callbacks, 6);
                resolve();
              } else {
                edits++;
                lastEdit = performance.now();
                fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\nmodule.exports += ' + edits + ';\n')]));
              }
            } catch (error) { reject(error); }
          }, 200);
        } catch (error) { reject(error); }
      });
    });
    const enabled = process.env.RSPACK_WATCHPACK_REUSE === '1';
    assert.equal(rearms.length, 6);
    assert.equal(rearms.slice(1).every(row => row.reused === enabled), true);
    fs.writeFileSync(path.join(results, 'timing.json'), JSON.stringify({ enabled, rearms, builds, callbacks, edits, peakRss: process.resourceUsage().maxRSS * 1024, steadyRss: process.memoryUsage().rss, coreEntrySha: hash(fs.readFileSync(process.env.CORE_ENTRY)), manifests }, null, 2) + '\n');
    console.log(JSON.stringify({ enabled, rearms, builds, callbacks, edits }));
  } finally {
    clearTimeout(scheduled);
    if (watching) await new Promise((resolve, reject) => watching.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
    fs.writeFileSync(file, original);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
