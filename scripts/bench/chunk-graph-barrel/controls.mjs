import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const api = require(process.env.RSPACK_CORE_PATH);
const root = path.resolve(process.env.FIXTURE_ROOT);
const put = (name, text) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const leaf = 'export function value() { return 1; }\n';
const barrel = "export { value } from './leaf.js';\n";
const entry = "import { value } from './barrel.js'; export function run() { return value(); }\n";
put('package.json', JSON.stringify({ name: 'topology-controls', private: true }));
put('entry.js', entry);
put('barrel.js', barrel);
put('leaf.js', leaf);
put('other.js', 'export function value() { return 2; }\n');
put('extra.js', 'export const extra = 3;\n');
put('lazy.js', 'export const lazy = 4;\n');
put('lazy2.js', 'export const lazy = 5;\n');
const changes = [
  ['body', 'leaf.js', leaf.replace('return 1', 'return 6'), false, 6],
  ['body-revert', 'leaf.js', leaf, false, 1],
  ['reexport-add', 'barrel.js', barrel + "export { extra } from './extra.js';\n", true, 1],
  ['reexport-remove', 'barrel.js', barrel, true, 1],
  ['target-switch', 'barrel.js', barrel.replace('leaf.js', 'other.js'), true, 2],
  ['target-revert', 'barrel.js', barrel, true, 1],
  ['import-add', 'leaf.js', "import { extra } from './extra.js'; export function value() { return extra; }\n", true, 3],
  ['import-remove', 'leaf.js', leaf, true, 1],
  ['dynamic-add', 'leaf.js', "export function value() { return import('./lazy.js').then(m => m.lazy); }\n", true, 4],
  ['dynamic-switch', 'leaf.js', "export function value() { return import('./lazy2.js').then(m => m.lazy); }\n", true, 5],
  ['dynamic-remove', 'leaf.js', leaf, true, 1],
  ['side-effects-add', 'barrel.js', barrel + 'globalThis.syntheticEffect = 7;\n', true, 1, 7],
  ['side-effects-remove', 'barrel.js', barrel, true, 1, 0],
];
const compiler = api.rspack({ context: root, mode: 'development', entry: './entry.js', target: 'async-node', devtool: false,
  output: { path: path.join(root, 'dist'), filename: 'main.js', chunkFilename: '[name].js', library: { type: 'commonjs2' }, uniqueName: 'topology-controls' },
  optimization: { sideEffects: true, splitChunks: false, moduleIds: 'named', chunkIds: 'named' },
  stats: { all: false, errors: true, warnings: true, logging: 'verbose', loggingDebug: [/rspack\./] }, infrastructureLogging: { level: 'error' } });
let current = ['cold', null, null, true, 1];
let resolve, reject;
const next = () => new Promise((a, b) => { resolve = a; reject = b; });
let completion = next();
const records = [];
const watch = compiler.watch({ aggregateTimeout: 20 }, async (error, stats) => {
  if (error) return reject(error);
  try {
    if (stats.hasErrors() || stats.hasWarnings()) throw new Error(stats.toString({ all: false, errors: true, warnings: true }));
    const text = stats.toString({ logging: 'verbose' });
    const rebuilt = text.includes('rebuild chunk graph');
    // Baseline must reject the body edit. The fix must reuse it.
    const expectedRebuild = current[3] || process.env.VARIANT === 'main';
    if (rebuilt !== expectedRebuild) console.error(text);
    assert.equal(rebuilt, expectedRebuild, `${current[0]} rebuild decision`);
    for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(root, 'dist'))) delete require.cache[key];
    delete globalThis.syntheticEffect;
    const compiled = require(path.join(root, 'dist/main.js'));
    assert.equal(await compiled.run(), current[4], `${current[0]} runtime`);
    assert.equal(globalThis.syntheticEffect || 0, current[5] || 0, `${current[0]} side effect`);
    const outputs = {};
    for (const asset of stats.compilation.getAssets()) outputs[asset.name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', asset.name))).digest('hex');
    records.push({ label: current[0], rebuilt, runtime: current[4], outputs });
    resolve();
  } catch (e) { reject(e); }
});
try {
  await completion;
  for (current of changes) {
    completion = next();
    put(current[1], current[2]);
    await completion;
  }
} finally {
  await new Promise((a, b) => watch.close(e => e ? b(e) : a()));
  await new Promise((a, b) => compiler.close(e => e ? b(e) : a()));
}
fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(records, null, 2));
console.log(JSON.stringify(records.map(({ outputs, ...r }) => r)));
