import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { generate, setBarrels } from './generate.mjs';

const require = createRequire(import.meta.url);
const binding = require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
const api = require(process.env.RSPACK_CORE_PATH);
const root = path.resolve(process.env.FIXTURE_ROOT);
const variant = process.env.VARIANT;
const split = process.env.SPLIT === '1';
if (!fs.existsSync(path.join(root, 'fixture.json'))) { generate(root); setBarrels(root, true); }
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const edited = path.join(root, 'packages/p0/lib/l0.js');
const original = 'export function x_0_0(value) { return value + 0; }\n';
const modified = original.replace('value + 0', 'value + 1');
fs.writeFileSync(edited, original);
const compiler = api.rspack({ context: root, mode: 'development', target: 'web', entry: './entry.js', devtool: 'cheap-module-source-map',
  output: { path: path.join(root, 'dist'), filename: '[name].js', chunkFilename: '[name].js', uniqueName: 'synthetic', clean: false },
  optimization: { moduleIds: 'named', chunkIds: 'named', minimize: false,
    splitChunks: split ? { chunks: 'all', minSize: 0, minChunks: 2, maxAsyncRequests: Infinity, maxInitialRequests: Infinity,
      cacheGroups: { packageLeaves: { test: /[\\/]packages[\\/]p\d+[\\/]lib[\\/]/, minChunks: 2, minSize: 0, priority: 30, reuseExistingChunk: false },
        packageConsumers: { test: /[\\/]packages[\\/]p\d+[\\/]consumer[\\/]/, minChunks: 2, minSize: 0, priority: 20, reuseExistingChunk: false },
        packageBarrels: { test: /[\\/]packages[\\/]p\d+[\\/](?:index|b\d+)\.js$/, minChunks: 2, minSize: 0, priority: 10, reuseExistingChunk: false } } } : false },
  stats: { all: false, errors: true, warnings: true, logging: 'verbose', loggingDebug: [/rspack\./] }, infrastructureLogging: { level: 'error' } });
const sample = () => {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const field = name => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
  return { native: binding.debugHeapMetrics(), rss: process.memoryUsage().rss, rssAnon: field('RssAnon'), peakRss: field('VmHWM'), heapUsed: process.memoryUsage().heapUsed };
};
const gc = async () => { await new Promise(a => setImmediate(a)); global.gc(); await new Promise(a => setImmediate(a)); global.gc(); };
let label = 'cold', resolve, reject;
const next = () => new Promise((a, b) => { resolve = a; reject = b; });
let completion = next();
const records = [];
const watch = compiler.watch({ aggregateTimeout: 20 }, (error, stats) => {
  if (error) return reject(error);
  try {
    if (stats.hasErrors() || stats.hasWarnings()) throw new Error(stats.toString({ all: false, errors: true, warnings: true }));
    const outputs = {};
    for (const asset of stats.compilation.getAssets()) outputs[asset.name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', asset.name))).digest('hex');
    const rebuilt = stats.toString({ logging: 'verbose' }).includes('rebuild chunk graph');
    records.push({ label, done: sample(), rebuilt, outputs });
    resolve();
  } catch (e) { reject(e); }
});
const afterBuild = async () => { await completion; await gc(); records.at(-1).postGc = sample(); console.log(JSON.stringify({ label, variant, split, ...records.at(-1).postGc })); };
try {
  await afterBuild();
  for (let i = 1; i <= 20; i++) {
    label = `${i}-${i % 2 ? 'edit' : 'revert'}`;
    completion = next();
    fs.writeFileSync(edited, i % 2 ? modified : original);
    await afterBuild();
  }
} finally {
  await new Promise((a, b) => watch.close(e => e ? b(e) : a()));
  await new Promise((a, b) => compiler.close(e => e ? b(e) : a()));
  fs.writeFileSync(edited, original);
}
await gc();
const end = sample();
const exclusive = compiler.__debugDropRetained();
await gc();
const afterDrop = sample();
fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({ variant, split, records, end, afterDrop, exclusive,
  exclusiveOrder: ['before', 'previous-final-graph', 'previous-rest', 'snapshot-code-splitter', 'snapshot-graph', 'current-final-graph', 'render-cache', 'codegen-cache', 'runtime-cache'] }));
console.log(JSON.stringify({ variant, split, end, exclusive, afterDrop }));
