const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { rspack } = require(path.resolve(process.env.CORE_ENTRY));
const root = path.resolve('bench-data/fixture');
const results = path.resolve(process.env.RESULT_DIR);
const enabled = process.env.RSPACK_SPLIT_CHUNKS_REPLAY === '1';
const labels = ['cold', 'content-1', 'content-2', 'topology', 'content-3'];
fs.mkdirSync(results, { recursive: true });
fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
const file = path.join(root, 'src/g0/m0.js');
const original = fs.readFileSync(file);
const addedFile = path.join(root, 'src/g0/added-module.js');
assert(!fs.existsSync(addedFile));
globalThis.loaderCalls = { noop: 0, ast: 0, rewrite: 0 };
const callbacks = { test: 0, name: 0, chunks: 0 };
const compiler = rspack({
  mode: 'development', context: root, entry: './entry.js', target: 'node',
  cache: false, devtool: 'cheap-module-source-map', incremental: { silent: false },
  output: { path: path.join(root, 'out'), filename: '[name].cjs', chunkFilename: '[name].[id].cjs' },
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
      chunks(chunk) { callbacks.chunks++; return true; }, minSize: 0,
      cacheGroups: {
        default: false, defaultVendors: false,
        shared: {
          type: 'javascript/auto',
          test(module) { callbacks.test++; return /[\\/]src[\\/]g\d+[\\/]/.test(module.resource || ''); },
          name(module, chunks, key) {
            callbacks.name++;
            const group = (module.resource || '').match(/[\\/]g(\d+)[\\/]/);
            return group ? 'group-' + group[1] : 'shared';
          }, enforce: true, minChunks: 1,
        },
      },
    },
  },
});
let notify;
compiler.watchFileSystem = {
  watch(_files, _dirs, _missing, _start, _options, callback) {
    notify = callback;
    return { close() {}, pause() {}, getInfo() { return { changes: new Set(), removals: new Set(), fileTimeInfoEntries: new Map(), contextTimeInfoEntries: new Map() }; } };
  },
};
let step = 0;
const rows = [];
let previousCallbacks = { ...callbacks };
const watching = compiler.watch({}, (error, stats) => {
  if (error || !stats || stats.hasErrors()) throw error || Error(stats?.toString({ all: false, errors: true }));
  const label = labels[step];
  assert(label, 'Unexpected watch rebuild');
  fs.cpSync(path.join(root, 'out'), path.join(results, label), { recursive: true });
  const json = stats.toJson({ all: false, assets: true, chunks: true, warnings: true, logging: 'verbose', loggingDebug: [/^rspack\.(SplitChunksPlugin|Compilation|incremental)/] });
  const entries = json.logging?.['rspack.SplitChunksPlugin']?.entries || [];
  const replay = entries.filter(entry => entry.message.startsWith('replay:')).map(entry => entry.message);
  assert.equal(replay.length, 1, 'Expected one replay decision per compilation');
  const hit = enabled && [1, 2, 4].includes(step);
  assert(replay[0].includes(hit ? 'replay: replayed ' : 'replay: full run ('), replay[0]);
  if (enabled && step === 0) assert(replay[0].includes('no record'), replay[0]);
  if (enabled && step === 3) assert(replay[0].includes('inputs changed'), replay[0]);
  const delta = Object.fromEntries(Object.entries(callbacks).map(([key, value]) => [key, value - previousCallbacks[key]]));
  previousCallbacks = { ...callbacks };
  if (hit) {
    assert.equal(delta.test, 0, 'Replay must skip cache-group tests');
    assert.equal(delta.name, 0, 'Replay must skip cache-group names');
  } else for (const value of Object.values(delta)) assert(value > 0, 'A full run must execute each callback selector');
  const processCacheGroups = entries.filter(entry => entry.message.startsWith('process cache groups:')).map(entry => entry.message);
  if (hit) assert.equal(processCacheGroups.length, 0);
  else assert.equal(processCacheGroups.length, 1);
  rows.push({ step: label, replay: replay[0], processCacheGroups, callbacks: delta, loaderCalls: { ...globalThis.loaderCalls }, chunkCount: json.chunks.length, warnings: json.warnings || [], logging: json.logging });
  console.log(JSON.stringify({ step: label, replay: replay[0], processCacheGroups, callbacks: delta }));
  if (step === 0) assert.equal(globalThis.loaderCalls.noop, 60701);
  if (step++ < 4) {
    setImmediate(() => {
      const content = [original, Buffer.from('\nmodule.exports += ' + step + ';\n')];
      const changed = [file];
      if (step >= 3) {
        if (step === 3) { fs.writeFileSync(addedFile, 'module.exports = 900001;\n'); changed.push(addedFile); }
        content.push(Buffer.from('\nimport("./added-module.js").then(value => { globalThis.addedFixtureValue = value.default; });\n'));
      }
      fs.writeFileSync(file, Buffer.concat(content));
      compiler.inputFileSystem.purge(changed);
      assert.equal(typeof notify, 'function');
      notify(null, new Map(), new Map(), new Set(changed), new Set());
    });
  } else {
    fs.writeFileSync(path.join(results, 'builds.json'), JSON.stringify(rows, null, 2) + '\n');
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(path.join(results, 'core-entry.json'), JSON.stringify({ entry: process.env.CORE_ENTRY, sha256: hash(process.env.CORE_ENTRY) }) + '\n');
    watching.close(error => {
      if (error) throw error;
      compiler.close(error => {
        if (error) throw error;
        fs.writeFileSync(file, original);
        fs.unlinkSync(addedFile);
      });
    });
  }
});
