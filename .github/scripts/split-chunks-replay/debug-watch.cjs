const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { rspack } = require(path.resolve(process.env.CORE_ENTRY));
const root = path.resolve('bench-data/fixture');
const results = path.resolve(process.env.RESULT_DIR);
const debug = process.env.RSPACK_CODE_SPLITTING_CACHE_DEBUG === '1';
const labels = ['cold', 'content', 'topology', 'content-after-topology'];
fs.mkdirSync(results, { recursive: true });
fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
const file = path.join(root, 'src/g0/m0.js');
const original = fs.readFileSync(file);
const addedFile = path.join(root, 'src/g0/added-module.js');
assert(!fs.existsSync(addedFile));
globalThis.loaderCalls = { noop: 0, ast: 0, rewrite: 0 };
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
  const label = labels[step];
  assert(label, 'Unexpected watch rebuild');
  fs.cpSync(path.join(root, 'out'), path.join(results, label), { recursive: true });
  const json = stats.toJson({ all: false, logging: 'log' });
  const entries = json.logging?.['rspack.Compilation.codeSplittingCache']?.entries || [];
  const lines = entries.map(entry => entry.message);
  const debugLines = lines.filter(line => line.startsWith('debug:'));
  const failures = debugLines.filter(line => line.startsWith('debug: module=') && !line.endsWith('accepted: stable absence'));
  if (!debug) assert.equal(debugLines.length, 0, 'Unset flag emitted diagnostics');
  if (debug && (step === 1 || step === 3)) {
    assert.equal(failures.length, 0, 'Content-only edit failed topology validation');
    assert(debugLines.some(line => /^debug: affected \d+, failing 0, rebuilt /.test(line)), 'Missing clean content summary');
  }
  if (debug && step === 2) {
    assert(debugLines.some(line => /^debug: affected \d+, failing [1-9]\d*, rebuilt /.test(line)), 'Missing topology failure summary');
    assert(failures.some(line => /blocks:|nested-block:|group options:|missing cached block:|count:|module mismatch:|state:|not-cached root:/.test(line)), 'Missing topology failure reason');
  }
  rows.push({ step: label, lines, loaderCalls: { ...globalThis.loaderCalls } });
  for (const line of lines) console.log(label + ' ' + line);
  if (step === 0) assert.equal(globalThis.loaderCalls.noop, 60701);
  if (step++ < 3) {
    setImmediate(() => {
      const content = [original, Buffer.from('\nmodule.exports += ' + step + ';\n')];
      const changed = [file];
      if (step === 2) {
        fs.writeFileSync(addedFile, 'module.exports = 900001;\n'); changed.push(addedFile);
      }
      if (step >= 2) {
        content.push(Buffer.from('\nimport("./added-module.js").then(value => { globalThis.addedFixtureValue = value.default; });\n'));
      }
      fs.writeFileSync(file, Buffer.concat(content));
      compiler.inputFileSystem.purge(changed);
      assert.equal(typeof notify, 'function');
      notify(null, new Map(), new Map(), new Set(changed), new Set());
    });
  } else {
    fs.writeFileSync(path.join(results, 'builds.json'), JSON.stringify(rows, null, 2) + '\n');
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
