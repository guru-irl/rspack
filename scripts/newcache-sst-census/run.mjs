import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.resolve('runtime/package.json'));
const { rspack } = require('@rspack/core');
const root = path.resolve('scripts/newcache-sst-census/project');
const start = performance.now();
const events = [];
let stored = false;
const compiler = rspack({
  name: 'parity', mode: 'development', context: root, entry: './src/index.js', devtool: false,
  output: { path: path.join(root, 'dist'), clean: false },
  module: { rules: [
    { test: /\.css$/, type: 'css/auto' },
    { test: /\.js$/, include: path.join(root, 'src'), use: [path.join(root, 'loaders/tag-loader.cjs')] },
  ] },
  cache: { type: 'filesystem', cacheLocation: path.join(root, 'cache'), buildDependencies: { harness: [import.meta.filename] } },
  experiments: { newCache: true },
  infrastructureLogging: { level: 'log', debug: /rspack\./ }, stats: 'none',
  plugins: [{ apply(compiler) {
    compiler.hooks.infrastructureLog.tap('census', (origin, type, args) => {
      events.push({ ms: performance.now() - start, origin, type, args });
      if (String(args).includes('Stored cache')) stored = true;
      return true;
    });
  } }],
});
await new Promise((resolve, reject) => compiler.run((error, stats) => {
  if (error || !stats || stats.hasErrors()) return reject(error || new Error(stats?.toString({ errors: true })));
  fs.writeFileSync('results/build.json', JSON.stringify({ version: rspack.version, modules: stats.compilation.modules.size, done_ms: performance.now() - start }));
  resolve();
}));
// Timer is runner-side idle time, not a benchmark sample. endIdle awaits the
// background job through shutdown/close; close success is the completion gate.
await new Promise(resolve => setTimeout(resolve, 30000));
if (!stored) throw new Error('Missing first-store completion log');
await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
if (events.some(e => /Failed to .*cache|cache.*unavailable/i.test(String(e.args)))) throw new Error('Cache failure');
fs.writeFileSync('results/events.json', JSON.stringify(events, null, 2));
console.log(JSON.stringify({ version: rspack.version, closed_ms: performance.now() - start, stored }));
