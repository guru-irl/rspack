const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { rspack } = require(path.resolve(process.env.CORE_ENTRY));
const root = path.resolve('bench-data/fixture');
const results = path.resolve(process.env.RESULT_DIR);
globalThis.loaderCalls = { noop: 0, ast: 0, rewrite: 0 };
const callbacks = { test: 0, name: 0, chunks: 0 };
const splitChunks = {
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
};
const compiler = rspack({
  mode: 'development',
  context: root,
  entry: './entry.js',
  target: 'node',
  cache: false,
  devtool: 'cheap-module-source-map',
  incremental: { silent: false },
  output: {
    path: path.join(root, 'out'),
    filename: '[name].cjs',
    chunkFilename: '[name].[id].cjs',
  },
  module: { rules: [
    { test: /\.ts$/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript' } } } } },
    { test: /[\\/]m\d*0\.js$/, use: path.join(root, 'ast.cjs') },
    { test: /[\\/]m(?:\d*(?:05|25|45|65|85)|5)\.js$/, use: path.join(root, 'rewrite.cjs') },
    { test: /\.[jt]s$/, enforce: 'post', use: { loader: path.join(root, 'noop.cjs'), options: { generic: true } } },
  ] },
  optimization: { minimize: false, concatenateModules: false, usedExports: false, moduleIds: 'deterministic', chunkIds: 'deterministic', splitChunks },
});
compiler.run((error, stats) => {
  if (error || !stats || stats.hasErrors()) throw error || Error(stats?.toString({ all: false, errors: true }));
  const json = stats.toJson({ all: false, chunks: true, warnings: true });
  assert.deepEqual(globalThis.loaderCalls, { noop: 60701, ast: 6000, rewrite: 3000 });
  assert(json.chunks.length > 1);
  for (const value of Object.values(callbacks)) assert(value > 0);
  const maps = fs.readFileSync('/proc/self/maps', 'utf8');
  const mapped = [...new Set(maps.split('\n').filter(line => /rspack[^/]*\.node$/.test(line)).map(line => line.trim().split(/\s+/).at(-1)))];
  assert.deepEqual(mapped, [fs.realpathSync(process.env.RSPACK_BINDING)]);
  const nativeSha256 = crypto.createHash('sha256').update(fs.readFileSync(mapped[0])).digest('hex');
  assert.equal(nativeSha256, process.env.EXPECTED_NATIVE_SHA);
  const row = { step: 'cold', chunkCount: json.chunks.length, nativeSha256, mapped, loaderCalls: globalThis.loaderCalls, callbacks, warnings: json.warnings || [] };
  compiler.close(error => {
    if (error) throw error;
    fs.writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(row, null, 2) + '\n');
    fs.writeFileSync(path.join(results, 'native.maps'), maps);
    console.log(JSON.stringify(row));
  });
});
