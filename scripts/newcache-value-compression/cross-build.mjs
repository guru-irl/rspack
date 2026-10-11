import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [mode, output] = process.argv.slice(2);
const root = path.resolve(process.env.PROJECT);
const { rspack } = await import(path.resolve(process.env.RSPACK_CORE));
const events = [];
let restoredModules = [];
const compiler = rspack({
  name: 'cross-build', mode: 'development', context: root, entry: './src/index.js', devtool: false,
  output: { path: path.join(root, 'dist') },
  module: { rules: [{ test: /\.js$/, use: [path.join(root, 'probe-loader.cjs')] }] },
  cache: { type: 'filesystem', cacheLocation: path.join(root, 'cache'), version: 'same-build-identity',
    readonly: mode !== 'seed', buildDependencies: { harness: [import.meta.filename] } },
  experiments: { newCache: true }, infrastructureLogging: { level: 'log', debug: /rspack\./ },
  plugins: [{ apply(c) {
    c.hooks.infrastructureLog.tap('cross-build', (origin, type, args) => {
      events.push({ origin, type, args }); return true;
    });
    c.hooks.done.tap('cross-build', stats => {
      if (stats.hasErrors()) throw new Error(stats.toString());
      restoredModules = [...stats.compilation.modules].map(m => ({ identifier: m.identifier(), built: m.buildInfo?.cacheable }));
    });
  } }]
});
await new Promise((resolve, reject) => compiler.run(error => error ? reject(error) : resolve()));
await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
const misses = events.filter(e => /Failed to decode cache entry/.test(String(e.args)));
const failures = events.filter(e => /Resetting cache|Failed to encode|cache.*unavailable/i.test(String(e.args)));
if (failures.length) throw new Error(`Unexpected cache failure: ${JSON.stringify(failures)}`);
if (mode === 'cross' && !misses.length) throw new Error('Expected decode-failure-as-miss when crossing builds');
if (mode === 'hit' && misses.length) throw new Error('Fresh same-build cache failed decode');
if (mode === 'seed' && !events.some(e => /Stored cache/.test(String(e.args)))) throw new Error('Seed was not persisted');
const marker = path.join(root, 'loader-called');
if (mode === 'hit' && fs.existsSync(marker)) throw new Error('Same-build module cache did not hit');
if (mode === 'cross' && !fs.existsSync(marker)) throw new Error('Cross-build module cache did not rebuild');
const emitted = fs.readFileSync(path.join(root, 'dist/main.js'));
fs.writeFileSync(output, JSON.stringify({ mode, misses: misses.length, events, restoredModules,
  output_sha256: crypto.createHash('sha256').update(emitted).digest('hex') }));
console.log(JSON.stringify({ mode, misses: misses.length }));
