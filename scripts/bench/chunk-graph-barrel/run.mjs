import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { generate, setBarrels } from './generate.mjs';

const require = createRequire(import.meta.url);
const api = require(process.env.RSPACK_CORE_PATH || '@rspack/core');
const root = path.resolve(process.env.FIXTURE_ROOT || '.spider/scratch/incremental-precision/fixture');
const resultRoot = path.resolve(process.env.RESULT_ROOT || '.spider/scratch/incremental-precision/results');
fs.mkdirSync(resultRoot, { recursive: true });
const small = process.env.SMOKE === '1';
const shape = small ? { packages: 2, leaves: 40, routes: 12, groupSize: 10 } : {};
const manifest = generate(root, shape);
const variant = process.env.VARIANT || 'stock';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const records = [];
fs.writeFileSync(path.join(resultRoot, 'environment.json'), JSON.stringify({ variant, apiVersion: api.rspackVersion ?? api.version,
  platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length, cpu: os.cpus()[0].model,
  memory: os.totalmem(), runnerImage: process.env.ImageVersion, runnerOS: process.env.RUNNER_OS, sourceSHA: process.env.SOURCE_SHA,
  transitiveOff: process.env.RSPACK_DIAG_TRANSITIVE_OFF === '1', manifest }, null, 2));

function config(barrels, split) {
  return { context: root, mode: 'development', target: 'web', entry: './entry.js', devtool: 'cheap-module-source-map',
    output: { path: path.join(root, 'dist'), filename: '[name].js', chunkFilename: '[name].js', uniqueName: 'synthetic', clean: false },
    optimization: { moduleIds: 'named', chunkIds: 'named', minimize: false,
      splitChunks: split ? { chunks: 'all', minSize: 0, minChunks: 2, maxAsyncRequests: Infinity, maxInitialRequests: Infinity,
        cacheGroups: { packageLeaves: { test: /[\\/]packages[\\/]p\d+[\\/]lib[\\/]/, minChunks: 2, minSize: 0, priority: 30, reuseExistingChunk: false },
          packageConsumers: { test: /[\\/]packages[\\/]p\d+[\\/]consumer[\\/]/, minChunks: 2, minSize: 0, priority: 20, reuseExistingChunk: false },
          packageBarrels: { test: /[\\/]packages[\\/]p\d+[\\/](?:index|b\d+)\.js$/, minChunks: 2, minSize: 0, priority: 10, reuseExistingChunk: false } } } : false },
    stats: { all: false, errors: true, warnings: true, logging: 'verbose', loggingDebug: [/rspack\./] },
    infrastructureLogging: { level: 'error' } };
}

async function arm(barrels, split, editKind) {
  setBarrels(root, barrels, shape);
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  const edited = path.join(root, manifest.editFile);
  const original = fs.readFileSync(edited, 'utf8');
  const modified = editKind === 'body' ? original.replace('value + 0', 'value + 1') : original + 'export const synthetic_added_export = 7;\n';
  if (original === modified) throw new Error('Edit did not change source');
  const compiler = api.rspack(config(barrels, split));
  let start, cpu, label = 'cold', currentResolve, currentReject;
  let previousChunks = new Map();
  compiler.hooks.watchRun.tap('SyntheticTiming', () => { start = performance.now(); cpu = process.cpuUsage(); });
  let watch;
  const next = () => new Promise((resolve, reject) => { currentResolve = resolve; currentReject = reject; });
  let completion = next();
  watch = compiler.watch({ aggregateTimeout: 20 }, (error, stats) => {
    const wallMs = performance.now() - start;
    const usage = process.cpuUsage(cpu);
    if (error) return currentReject(error);
    if (stats.hasErrors()) return currentReject(new Error(stats.toString({ all: false, errors: true })));
    try {
      const json = stats.toJson({ all: false, errors: true, warnings: true, logging: 'verbose', loggingDebug: [/rspack\./] });
      if (json.warnings?.length) throw new Error(`Warnings invalidate this arm: ${JSON.stringify(json.warnings)}`);
      const compilation = stats.compilation;
      const outputs = {};
      for (const asset of compilation.getAssets()) {
        const expected = Buffer.from(asset.source.buffer ? asset.source.buffer() : asset.source.source());
        const disk = fs.readFileSync(path.join(root, 'dist', asset.name));
        if (!expected.equals(disk)) throw new Error(`Emitted bytes differ from compilation: ${asset.name}`);
        outputs[asset.name] = hash(disk);
      }
      const chunks = [];
      let unchangedLogicalChunks = 0;
      const nextChunks = new Map();
      for (const chunk of compilation.chunks) {
        const modules = [...compilation.chunkGraph.getChunkModulesIterable(chunk)].map(m => m.identifier().replaceAll(root, '<fixture>')).sort();
        const signature = hash(JSON.stringify({ id: chunk.id, runtime: [...chunk.runtime].sort(), modules }));
        const item = { id: chunk.id, signature, hash: chunk.hash, contentHash: chunk.contentHash, modules: modules.length, files: [...chunk.files] };
        if (previousChunks.get(signature)?.hash === item.hash) unchangedLogicalChunks++;
        nextChunks.set(signature, item); chunks.push(item);
      }
      previousChunks = nextChunks;
      const record = { variant, barrels, split, editKind, label, wallMs, cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000,
        rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024, unchangedLogicalChunks,
        logging: json.logging, outputs, chunks };
      records.push(record);
      const id = `${barrels ? 'barrels' : 'direct'}-${split ? 'split' : 'unsplit'}-${editKind}-${label}`;
      fs.writeFileSync(path.join(resultRoot, `${id}.json`), JSON.stringify(record));
      console.log(JSON.stringify({ event: 'sample', id, wallMs, cpuMs: record.cpuUserMs + record.cpuSystemMs, chunks: chunks.length, unchangedLogicalChunks }));
      currentResolve();
    } catch (e) { currentReject(e); }
  });
  try {
    await completion;
    for (let cycle = 0; cycle < (small ? 1 : 5); cycle++) for (const revert of [false, true]) {
      label = `${cycle + 1}-${revert ? 'revert' : 'edit'}`;
      completion = next();
      fs.writeFileSync(edited, revert ? original : modified);
      // Use the real watch path; one write, one callback. No invalidation fallback.
      await completion;
    }
  } finally {
    await new Promise((resolve, reject) => watch.close(e => e ? reject(e) : resolve()));
    await new Promise((resolve, reject) => compiler.close(e => e ? reject(e) : resolve()));
    fs.writeFileSync(edited, original);
  }
}

for (const barrels of [true, false]) for (const split of [true, false]) {
  for (const editKind of process.env.BODY_ONLY === '1' ? ['body'] : ['body', 'export']) await arm(barrels, split, editKind);
}
fs.writeFileSync(path.join(resultRoot, 'index.json'), JSON.stringify(records.map(({ outputs, chunks, ...r }) => r), null, 2));
