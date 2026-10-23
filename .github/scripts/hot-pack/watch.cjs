const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { rspack } = require(path.resolve(process.env.CORE_ENTRY));
const root = path.resolve('bench-data/fixture');
const results = path.resolve(process.env.RESULT_DIR);
const variant = process.env.VARIANT;
assert(['deterministic', 'split-chunks'].includes(variant));
fs.mkdirSync(results, { recursive: true });
fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
const file = path.join(root, 'src/g0/m0.js');
const original = fs.readFileSync(file);
const addedFile = path.join(root, 'src/g0/added-module.js');
assert(!fs.existsSync(addedFile));
globalThis.loaderCalls = { noop: 0, ast: 0, rewrite: 0 };
const callbacks = { test: 0, name: 0, chunks: 0 };
const splitChunks = variant === 'split-chunks' ? {
  chunks(chunk) { callbacks.chunks++; return true; },
  minSize: 0,
  cacheGroups: {
    default: false,
    defaultVendors: false,
    shared: {
      type: 'javascript/auto',
      test(module) {
        callbacks.test++;
        return /[\\/]src[\\/]g\d+[\\/]/.test(module.resource || '');
      },
      name(module, chunks, key) {
        callbacks.name++;
        const group = (module.resource || '').match(/[\\/]g(\d+)[\\/]/);
        return group ? 'group-' + group[1] : 'shared';
      },
      enforce: true,
      minChunks: 1,
    },
  },
} : false;
const compiler = rspack({
  mode: 'development',
  context: root,
  entry: './entry.js',
  target: 'node',
  cache: false,
  devtool: 'cheap-module-source-map',
  incremental: { silent: false },
  output: { path: path.join(root, 'out'), filename: 'bundle.cjs', chunkFilename: '[name].cjs' },
  module: { rules: [
    { test: /\.ts$/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript' } } } } },
    { test: /[\\/]m\d*0\.js$/, use: path.join(root, 'ast.cjs') },
    { test: /[\\/]m(?:\d*(?:05|25|45|65|85)|5)\.js$/, use: path.join(root, 'rewrite.cjs') },
    { test: /\.[jt]s$/, enforce: 'post', use: { loader: path.join(root, 'noop.cjs'), options: { generic: true } } },
  ] },
  optimization: { minimize: false, concatenateModules: false, usedExports: false, moduleIds: 'deterministic', chunkIds: 'deterministic', splitChunks },
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
const watching = compiler.watch({}, (error, stats) => {
  if (error || !stats || stats.hasErrors()) throw error || Error(stats?.toString({ all: false, errors: true }));
  const label = ['cold', 'rebuild', 'add-module'][step];
  assert(label, 'Unexpected watch rebuild');
  fs.cpSync(path.join(root, 'out'), path.join(results, label), { recursive: true });
  const json = stats.toJson({ all: false, assets: true, chunks: true, warnings: true, logging: 'verbose', loggingDebug: [/^rspack\.(Compilation|incremental)/] });
  rows.push({ step: label, hash: stats.hash, loaderCalls: { ...globalThis.loaderCalls }, callbacks: { ...callbacks }, assets: json.assets.map(asset => asset.name).sort(), chunkCount: json.chunks.length, warnings: json.warnings || [], logging: json.logging });
  fs.writeFileSync(path.join(results, 'warnings.json'), JSON.stringify(rows.map(row => ({ step: row.step, warnings: row.warnings, logging: row.logging })), null, 2) + '\n');
  if (step++ === 0) {
    assert.deepEqual(globalThis.loaderCalls, { noop: 60701, ast: 6000, rewrite: 3000 });
    if (variant === 'split-chunks') for (const value of Object.values(callbacks)) assert(value > 0, 'A requested callback did not execute');
    setImmediate(() => {
      fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\nmodule.exports += 1;\n')]));
      compiler.inputFileSystem.purge([file]);
      assert.equal(typeof notify, 'function');
      notify(null, new Map(), new Map(), new Set([file]), new Set());
    });
  } else if (step === 2 && variant === 'deterministic') {
    assert.equal(globalThis.loaderCalls.noop, 60702, 'The content edit must rebuild one module');
    setImmediate(() => {
      fs.writeFileSync(addedFile, 'module.exports = 900001;\n');
      fs.appendFileSync(file, '\nimport("./added-module.js").then(value => { globalThis.addedFixtureValue = value.default; });\n');
      compiler.inputFileSystem.purge([file, addedFile]);
      notify(null, new Map(), new Map(), new Set([file, addedFile]), new Set());
    });
  } else {
    assert.equal(step, variant === 'deterministic' ? 3 : 2);
    assert.equal(globalThis.loaderCalls.noop, variant === 'deterministic' ? 60704 : 60702, 'Unexpected rebuilt source-module count');
    if (variant === 'deterministic') assert(rows[2].chunkCount > rows[1].chunkCount, 'The new import must create a new chunk');
    fs.writeFileSync(path.join(results, 'builds.json'), JSON.stringify(rows, null, 2) + '\n');
    watching.close(error => {
      if (error) throw error;
      compiler.close(error => {
        if (error) throw error;
        fs.writeFileSync(file, original);
        if (fs.existsSync(addedFile)) fs.unlinkSync(addedFile);
        console.log(JSON.stringify({ variant, rows }));
      });
    });
  }
});
