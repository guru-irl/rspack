import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { generate, setBarrels } from './generate.mjs';

const require = createRequire(import.meta.url);
const api = require(process.env.RSPACK_CORE_PATH);
const root = path.resolve(process.env.FIXTURE_ROOT);
const result = path.resolve(process.env.RESULT_FILE);
const split = process.env.SPLIT === '1';
const variant = process.env.VARIANT;
if (!fs.existsSync(path.join(root, 'fixture.json'))) {
  generate(root);
  setBarrels(root, true);
}
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const edited = path.join(root, 'packages/p0/lib/l0.js');
const original = 'export function x_0_0(value) { return value + 0; }\n';
const modified = original.replace('value + 0', 'value + 1');
fs.writeFileSync(edited, original);
const compiler = api.rspack({
  context: root, mode: 'development', target: 'web', entry: './entry.js', devtool: 'cheap-module-source-map',
  output: { path: path.join(root, 'dist'), filename: '[name].js', chunkFilename: '[name].js', uniqueName: 'synthetic', clean: false },
  optimization: { moduleIds: 'named', chunkIds: 'named', minimize: false,
    splitChunks: split ? { chunks: 'all', minSize: 0, minChunks: 2, maxAsyncRequests: Infinity, maxInitialRequests: Infinity,
      cacheGroups: { packageLeaves: { test: /[\\/]packages[\\/]p\d+[\\/]lib[\\/]/, minChunks: 2, minSize: 0, priority: 30, reuseExistingChunk: false },
        packageConsumers: { test: /[\\/]packages[\\/]p\d+[\\/]consumer[\\/]/, minChunks: 2, minSize: 0, priority: 20, reuseExistingChunk: false },
        packageBarrels: { test: /[\\/]packages[\\/]p\d+[\\/](?:index|b\d+)\.js$/, minChunks: 2, minSize: 0, priority: 10, reuseExistingChunk: false } } } : false },
  stats: { all: false, errors: true, warnings: true, logging: 'verbose', loggingDebug: [/rspack\./] },
  infrastructureLogging: { level: 'error' },
});
let start, label = 'cold', resolve, reject;
const records = [];
const next = () => new Promise((a, b) => { resolve = a; reject = b; });
compiler.hooks.watchRun.tap('Timing', () => { start = performance.now(); });
let completion = next();
const watch = compiler.watch({ aggregateTimeout: 20 }, (error, stats) => {
  const wallMs = performance.now() - start;
  const rss = process.memoryUsage().rss;
  if (error) return reject(error);
  try {
    if (stats.hasErrors() || stats.hasWarnings()) throw new Error(stats.toString({ all: false, errors: true, warnings: true }));
    const logging = stats.toJson({ all: false, logging: 'verbose', loggingDebug: [/rspack\./] }).logging;
    const outputs = {};
    for (const asset of stats.compilation.getAssets()) {
      const disk = fs.readFileSync(path.join(root, 'dist', asset.name));
      const source = Buffer.from(asset.source.buffer ? asset.source.buffer() : asset.source.source());
      if (!disk.equals(source)) throw new Error(`Emitted bytes differ: ${asset.name}`);
      outputs[asset.name] = crypto.createHash('sha256').update(disk).digest('hex');
    }
    records.push({ label, wallMs, rss, peakRss: process.resourceUsage().maxRSS * 1024, logging, outputs });
    resolve();
  } catch (e) { reject(e); }
});
let steadyEndRss;
try {
  await completion;
  for (const revert of [false, true]) {
    label = revert ? 'revert' : 'edit';
    completion = next();
    fs.writeFileSync(edited, revert ? original : modified);
    await completion;
  }
  global.gc();
  steadyEndRss = process.memoryUsage().rss;
} finally {
  await new Promise((a, b) => watch.close(e => e ? b(e) : a()));
  await new Promise((a, b) => compiler.close(e => e ? b(e) : a()));
  fs.writeFileSync(edited, original);
}
global.gc();
const endRss = process.memoryUsage().rss;
const peakRss = process.resourceUsage().maxRSS * 1024;
fs.mkdirSync(path.dirname(result), { recursive: true });
fs.writeFileSync(result, JSON.stringify({ variant, split, records, steadyEndRss, endRss, peakRss,
  environment: { node: process.version, apiVersion: api.rspackVersion, cpu: os.cpus()[0].model, cpus: os.cpus().length,
    memory: os.totalmem(), image: process.env.ImageVersion, platform: process.platform, arch: process.arch,
    baseline: process.env.BASELINE_SHA, fix: process.env.FIX_SHA, nativeSHA: process.env.NATIVE_SHA } }));
console.log(JSON.stringify({ variant, split, wallMs: records[1].wallMs, steadyEndRss, endRss, peakRss }));
