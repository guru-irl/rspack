import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { rspack } from '@rspack/core';

const require = createRequire(import.meta.url);
const root = path.resolve(process.env.FIXTURE_ROOT || '.spider/scratch/split-chunks-reuse/run');
const out = path.join(root, 'results');
const src = path.join(root, 'src');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(src, { recursive: true });
const parameter = (name, fallback) => Number(process.env[name] ?? fallback);
const moduleCount = parameter('MODULES', 60000);
const routeCount = parameter('CHUNKS', 3000);
const groupCount = parameter('GROUPS', 100);
const priorityCount = parameter('PRIORITIES', 40);
const enforceCount = Math.round(groupCount * parameter('ENFORCE_RATIO', 0.9));
const reuseCount = Math.round(groupCount * parameter('REUSE_RATIO', 0.4));
const cssCount = parameter('CSS_GROUPS', 4);
const minSizeCount = Math.round(groupCount * parameter('MIN_SIZE_RATIO', 0.9));
const nonzeroMinSizeCount = Math.round(minSizeCount * parameter('NONZERO_MIN_SIZE_RATIO', 0.2));
const minChunksCount = Math.round(groupCount * parameter('MIN_CHUNKS_RATIO', 0.3));
const familyName = n => `family-${String.fromCharCode(97 + n % 4)}`;
if (![moduleCount, routeCount, groupCount, priorityCount, cssCount].every(Number.isInteger) || groupCount < 12 || cssCount < 0 || cssCount > groupCount - 9 || routeCount < 4 || moduleCount <= routeCount || priorityCount < 1) throw new Error('Invalid fixture parameters');
const payloadCount = moduleCount - routeCount - 1;
const sampleCount = parameter('SAMPLES', 25);
if (!global.gc) throw new Error('Run with --expose-gc');
const native = require('@rspack/binding');
const heapMetrics = () => native.debugHeapMetrics?.() ?? null;
const fullStats = process.env.FULL_STATS !== '0';
const forceGc = process.env.FORCE_GC !== '0';
const isCss = i => i % groupCount >= groupCount - cssCount;
const payloadPath = i => `payload/g${String(i % groupCount).padStart(3, '0')}/m${i}.${isCss(i) ? 'css' : 'js'}`;
for (let g = 0; g < groupCount; g++) fs.mkdirSync(path.join(src, `payload/g${String(g).padStart(3, '0')}`), { recursive: true });
fs.mkdirSync(path.join(src, 'routes'), { recursive: true });
for (let i = 0; i < payloadCount; i++) {
  const text = isCss(i) ? `.public_${i}{color:#112233}\n` : `export default ${i % 1000};/*${'x'.repeat(96 + i % 3 * 64)}*/\n`;
  fs.writeFileSync(path.join(src, payloadPath(i)), text);
}
const routeImports = Array.from({ length: routeCount }, () => []);
for (let i = 0; i < payloadCount; i++) {
  for (let j = 0; j < 3; j++) routeImports[(i + j * 997) % routeCount].push(i);
}
for (let r = 0; r < routeCount; r++) {
  const modules = routeImports[r];
  const imports = modules.map(i => isCss(i) ? `import '../${payloadPath(i)}';` : `import p${i} from '../${payloadPath(i)}';`).join('\n');
  const sum = modules.filter(i => !isCss(i)).map(i => `p${i}`).join('+') || '0';
  fs.writeFileSync(path.join(src, `routes/r${r}.js`), `${imports}\nexport default ${sum};\n`);
}
fs.writeFileSync(path.join(src, 'index.js'), `export const load=[\n${Array.from({ length: routeCount }, (_, r) => `()=>import(/* webpackChunkName: "${familyName(r)}-route${r}" */ './routes/r${r}.js')`).join(',\n')}\n];\n`);
const packageFile = path.join(src, 'public-package.json');
fs.writeFileSync(packageFile, JSON.stringify({ name: 'public-synthetic-package', version: '1.0.0' }));
const version = require(packageFile).version;
let counters = {};
function measured(name, fn) {
  return (...args) => {
    const start = performance.now();
    try { return fn(...args); }
    finally {
      const c = counters[name] ||= { calls: 0, ms: 0 };
      c.calls++;
      c.ms += performance.now() - start;
    }
  };
}
const resourceMatches = (m, g) => Boolean(m.resource?.replaceAll('\\', '/').includes(`/g${String(g).padStart(3, '0')}/`));
const tests = Array.from({ length: 4 }, (_, g) => measured(`test-membership-${g}`, (m, { chunkGraph }) => {
  let count = 0;
  for (const chunk of chunkGraph.getModuleChunksIterable(m)) if (chunk.name?.startsWith(familyName(g))) count++;
  return count >= 1 && resourceMatches(m, g);
}));
tests.push(measured('test-size-resource', m => m.size() > 80 && resourceMatches(m, 4)));
tests.push(measured('test-package-version', m => version === '1.0.0' && resourceMatches(m, 5)));
const chunkSelector = measured('chunks-prefix', chunk => chunk.name?.startsWith('family-') === true);
const nameConsumers = measured('name-consumers', (m, chunks) => `consumer-${chunks.every(c => c.name?.startsWith('family-a')) ? 'zero' : 'mixed'}`);
const nameSize = measured('name-size-band', m => `size-band-${Math.floor(m.size() / 128)}`);
const cacheGroups = { default: false, defaultVendors: false };
for (let g = 0; g < groupCount; g++) {
  const group = {
    test: g < 6 ? tests[g] : new RegExp(String.raw`[\\/]g${String(g).padStart(3, '0')}[\\/]`),
    priority: g < 6 ? priorityCount - 1 : g % priorityCount,
    ...(g < enforceCount ? { enforce: true } : {}),
    ...(g < minSizeCount ? { minSize: g < nonzeroMinSizeCount ? 256 : 0 } : {}),
    ...(g < minChunksCount ? { minChunks: 2 } : {}),
    ...(g < reuseCount ? { reuseExistingChunk: true } : {}),
    ...(g >= groupCount - cssCount ? { type: 'css' } : {}),
    ...(g === 6 ? { chunks: chunkSelector } : {}),
    name: g === 7 ? nameConsumers : g === 8 ? nameSize : `split-group${g}`,
  };
  cacheGroups[`group${g}`] = group;
}
const config = {
  context: src, mode: 'development', target: 'node', devtool: false,
  entry: './index.js', cache: false, incremental: true,
  experiments: { css: true },
  module: { rules: [{ test: /\.css$/, type: 'css' }] },
  output: { path: path.join(root, 'dist'), filename: 'main.cjs', chunkFilename: '[name].cjs', library: { type: 'commonjs2' } },
  optimization: { minimize: false, concatenateModules: false, usedExports: false, splitChunks: { chunks: 'all', minSize: 256, minChunks: 2, cacheGroups } },
  stats: { preset: 'none', logging: 'verbose', loggingDebug: [/rspack\./] },
};
const compiler = rspack(config);
const records = [];
const editedFile = path.join(src, payloadPath(0));
const original = fs.readFileSync(editedFile, 'utf8');
const getBaseSum = r => routeImports[r].filter(i => !isCss(i)).reduce((n, i) => n + i % 1000, 0);
let build = 0;
let started = 0;
let peakRss = 0;
const rssTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
rssTimer.unref();
compiler.hooks.watchRun.tap('PublicSplitChunksProbe', () => { counters = {}; started = performance.now(); peakRss = process.memoryUsage().rss; });
function durations(logging) {
  const values = {};
  for (const [logger, group] of Object.entries(logging || {})) for (const e of group.entries || []) {
    if (e.type === 'time') {
      // Stats serializes logger timing into "label: N ms" messages.
      const text = e.message || String(e.args?.[0] || '');
      const match = text.match(/^(.*?):\s*([\d.]+)\s*ms$/);
      if (match) values[`${logger}/${match[1]}`] = Number(match[2]);
    }
  }
  return values;
}
const manifest = {
  fixture: { moduleCount, routeCount, payloadCount, moduleChunkEdges: payloadCount * 3 + routeCount + 1, groups: groupCount, priorities: [...new Set(Object.values(cacheGroups).filter(Boolean).map(g => g.priority))].length, enforced: enforceCount, reuse: reuseCount, cssGroups: cssCount, minSizeGroups: minSizeCount, nonzeroMinSizeGroups: nonzeroMinSizeCount, minChunksGroups: minChunksCount, testFunctions: 6, chunksFunctions: 1, nameFunctions: 2 },
  system: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus(), memory: os.totalmem(), release: os.release(), runnerImage: process.env.ImageVersion, commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID },
  versions: { core: require('@rspack/core/package.json').version, binding: require('@rspack/binding/package.json').version },
  selectorsInstrumented: true, samples: sampleCount, forceGc, fullStats,
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
const nativePackage = '@rspack/binding-linux-x64-gnu';
try { const binary = process.env.NAPI_RS_NATIVE_LIBRARY_PATH || require.resolve(nativePackage); manifest.nativeSha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'); }
catch (e) { manifest.nativeHashError = String(e); }
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => { reject(new Error('Watch benchmark exceeded 25 minutes')); }, 25 * 60 * 1000);
  const watcher = compiler.watch({ aggregateTimeout: 20 }, async (error, stats) => {
    try {
      if (error) throw error;
      if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
      const doneMemory = process.memoryUsage();
      const doneNative = heapMetrics();
      let data = stats.toJson({ all: false, errors: true, warnings: true, timings: true, logging: 'verbose', loggingDebug: [/rspack\./], chunks: fullStats, modules: fullStats });
      let logging = data.logging;
      const timers = durations(logging);
      fs.writeFileSync(path.join(out, `logging-${build}.json`), JSON.stringify(logging, null, 2));
      const main = path.join(root, 'dist/main.cjs');
      for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(root, 'dist') + path.sep)) delete require.cache[key];
      let lib = require(main);
      const actual = (await lib.load[0]()).default;
      const expected = getBaseSum(0) + (build % 2);
      if (actual !== expected) throw new Error(`Output mismatch on build ${build}: ${actual} !== ${expected}`);
      const splitTimer = Object.entries(timers).find(([key]) => key.endsWith('/process cache groups'))?.[1];
      if (splitTimer === undefined) throw new Error(`Missing process cache groups timer; see logging-${build}.json`);
      const reconstructed = Object.keys(timers).some(key => key.endsWith('/rebuild chunk graph'));
      if (build === 0 && !reconstructed) throw new Error('Initial build did not establish chunk graph timer coverage');
      if (build > 0 && reconstructed) throw new Error(`Topology reconstruction on edit ${build}`);
      records.push({ doneMemory, doneNative, build, kind: build === 0 ? 'initial' : 'edit', editedValue: build % 2, compilerMs: stats.endTime - stats.startTime, editWallMs: performance.now() - started, timers, selectors: counters, chunks: data.chunks?.length, modules: data.modules?.length, memory: process.memoryUsage(), sampledPeakRss: peakRss, preSplitTopologyReused: build > 0 && !reconstructed, lifetimeMaxRssKiB: process.resourceUsage().maxRSS, outputParity: true, warnings: data.warnings });
      // Drop temporary stats and output references before GC. The compiler stays live.
      data = null; logging = null; lib = null;
      for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(root, 'dist') + path.sep)) delete require.cache[key];
      await new Promise(resolve => setImmediate(resolve));
      if (forceGc) global.gc();
      await new Promise(resolve => setImmediate(resolve));
      if (forceGc) global.gc();
      records.at(-1).postGcMemory = process.memoryUsage();
      records.at(-1).postGcNative = heapMetrics();
      fs.writeFileSync(path.join(out, 'builds.json'), JSON.stringify(records, null, 2));
      console.log(JSON.stringify({ build, compilerMs: records.at(-1).compilerMs, processCacheGroupsMs: splitTimer, chunks: records.at(-1).chunks, modules: records.at(-1).modules, selectors: counters, rss: records.at(-1).memory.rss }));
      if (build >= sampleCount) {
        clearTimeout(deadline);
        clearInterval(rssTimer);
        watcher.close(closeError => compiler.close(compilerError => closeError || compilerError ? reject(closeError || compilerError) : resolve()));
        return;
      }
      build++;
      // Length-changing body edits preserve dependency/export/topology shape.
      setTimeout(() => fs.writeFileSync(editedFile, original.replace('export default 0;', `export default ${build % 2};/*edit-${'x'.repeat(build * 17)}*/`)), 100);
    } catch (e) {
      clearTimeout(deadline);
      clearInterval(rssTimer);
      watcher.close(() => compiler.close(() => reject(e)));
    }
  });
});
console.log('VALID', records.length - 1, 'watch edits');
