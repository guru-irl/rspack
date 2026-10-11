import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require(process.env.RSPACK_CORE_PATH);
const root = path.resolve(process.env.FIXTURE_ROOT);
fs.mkdirSync(root, { recursive: true });
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const fixture = {
  'package.json': JSON.stringify({ sideEffects: false }),
  'index.js': "import { lookup } from './wrapper.js'; import { text } from './leaf.js'; export { lookup, text };\n",
  'wrapper.js': "export { lookup } from './resolver.js';\n",
  'resolver.js': "export const lookup = () => import('./handler.js').then(m => m.value);\n",
  'handler.js': "export const value = 'public-handler';\n",
  'leaf.js': "export const text = 'baseline';\n",
};
for (const [name, source] of Object.entries(fixture)) fs.writeFileSync(path.join(root, name), source);
const compiler = api.rspack({ context: root, mode: 'development', target: 'node', entry: './index.js', devtool: 'cheap-module-source-map',
  output: { path: path.join(root, 'dist'), filename: 'main.cjs', chunkFilename: '[name].cjs', library: { type: 'commonjs2' } },
  optimization: { sideEffects: true, usedExports: true, concatenateModules: false, minimize: false, moduleIds: 'named', chunkIds: 'named' },
  plugins: [{ apply(compiler) {
    compiler.hooks.finishMake.tapPromise('RebuildStableResolver', async compilation => {
      const resolver = [...compilation.modules].find(module => module.resource === path.join(root, 'resolver.js'));
      if (resolver) await new Promise((resolve, reject) => compilation.rebuildModule(resolver, error => error ? reject(error) : resolve()));
    });
  } }],
  stats: { all: false, errors: true, warnings: true, logging: 'verbose', loggingDebug: [/rspack\./] }, infrastructureLogging: { level: 'error' } });
let label = 'cold', resolve, reject;
const next = () => new Promise((a, b) => { resolve = a; reject = b; });
let completion = next();
const records = [];
const watch = compiler.watch({ aggregateTimeout: 20 }, async (error, stats) => {
  if (error) return reject(error);
  try {
    if (stats.hasErrors() || stats.hasWarnings()) throw new Error(stats.toString({ all: false, errors: true, warnings: true }));
    const rebuilt = stats.toString({ logging: 'verbose' }).includes('rebuild chunk graph');
    assert.equal(rebuilt, label === 'cold' || process.env.VARIANT === 'main');
    const wrapper = [...stats.compilation.modules].find(module => module.resource === path.join(root, 'wrapper.js'));
    assert(wrapper);
    assert.equal([...stats.compilation.chunkGraph.getModuleChunksIterable(wrapper)].length, 0);
    for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(root, 'dist'))) delete require.cache[key];
    const compiled = require(path.join(root, 'dist/main.cjs'));
    assert.equal(compiled.text, label === 'edit' ? 'changed' : 'baseline');
    assert.equal(await compiled.lookup(), 'public-handler');
    const outputs = {};
    for (const asset of stats.compilation.getAssets()) {
      const disk = fs.readFileSync(path.join(root, 'dist', asset.name));
      const source = Buffer.from(asset.source.buffer ? asset.source.buffer() : asset.source.source());
      assert(disk.equals(source));
      outputs[asset.name] = crypto.createHash('sha256').update(disk).digest('hex');
    }
    records.push({ label, rebuilt, outputs });
    resolve();
  } catch (e) { reject(e); }
});
try {
  await completion;
  for (label of ['edit', 'revert']) {
    await new Promise(resolve => setTimeout(resolve, 600));
    completion = next();
    fs.writeFileSync(path.join(root, 'leaf.js'), `export const text = '${label === 'edit' ? 'changed' : 'baseline'}';\n`);
    await completion;
  }
} finally {
  await new Promise((a, b) => watch.close(e => e ? b(e) : a()));
  await new Promise((a, b) => compiler.close(e => e ? b(e) : a()));
}
fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(records));
console.log(JSON.stringify(records.map(({ outputs, ...r }) => r)));
