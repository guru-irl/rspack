import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { groupsFor } from './groups.mjs';

const [fixtureArg, coreArg, outArg] = process.argv.slice(2);
if (!fixtureArg || !coreArg || !outArg) throw new Error('Usage: launch.mjs fixture core output');
const fixture = path.resolve(fixtureArg);
const out = path.resolve(outArg);
const src = path.join(fixture, 'src');
const leaf = path.join(src, 'packages/p000/m00000.js');
const original = fs.readFileSync(leaf);
const edited = Buffer.from('export const value = 999999;\n');
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
const report = {
  schema: 1, pid: process.pid,
  host: { platform: process.platform, arch: process.arch, release: os.release(),
    cpuCount: os.cpus().length, availableParallelism: os.availableParallelism(),
    cpuModel: os.cpus()[0]?.model, node: process.version, uv: process.versions.uv },
  environment: { spinRounds: process.env.RSPACK_RAYON_SPIN_ROUNDS ?? null,
    spinMode: process.env.RSPACK_RAYON_SPIN_MODE ?? null,
    rayonNumThreads: process.env.RAYON_NUM_THREADS ?? null,
    tokioWorkerThreads: process.env.TOKIO_WORKER_THREADS ?? null },
  builds: [], idleSamples: [],
};
function memory() {
  const sample = { elapsedMs: performance.now() - wallStart,
    rssMiB: process.memoryUsage.rss() / 1048576,
    peakRssMiB: process.resourceUsage().maxRSS / 1024 };
  if (process.platform === 'linux') {
    const text = fs.readFileSync('/proc/self/status', 'utf8');
    const match = /^RssAnon:\s+(\d+) kB$/m.exec(text);
    if (!match) throw new Error('RssAnon missing');
    sample.rssAnonMiB = Number(match[1]) / 1024;
  }
  if (!(sample.peakRssMiB > 0)) throw new Error('Native maxRSS unsupported');
  return sample;
}
const median = xs => { const s = [...xs].sort((a,b) => a-b); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i-1]+s[i])/2; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function cacheGroupsMs(stats) {
  const logging = stats.toJson({ all: false, logging: 'verbose', loggingDebug: [/SplitChunks/] }).logging;
  const hits = [];
  const walk = entries => {
    for (const item of entries || []) {
      const match = /^process cache groups:\s*([\d.eE+-]+) ms$/.exec(item.message || '');
      if (match) hits.push(Number(match[1]));
      walk(item.children);
    }
  };
  for (const [name, value] of Object.entries(logging || {})) {
    if (name.includes('SplitChunks')) walk(value.entries);
  }
  if (hits.length !== 1 || !Number.isFinite(hits[0]) || hits[0] < 0) {
    throw new Error(`Expected one SplitChunks process cache groups time, got ${JSON.stringify(hits)}; logging=${JSON.stringify(logging)}`);
  }
  return hits[0];
}
let compiler;
let watching;
let pending;
let unexpected;
try {
  const { rspack } = await import(pathToFileURL(path.resolve(coreArg, 'dist/index.js')).href);
  const invalidations = [];
  compiler = rspack({
    name: 'wake-memory', context: src, mode: 'development', devtool: false, cache: false,
    entry: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`entry${i}`, `./entry${i}.js`])),
    output: { path: path.join(fixture, 'dist'), filename: '[name].js', chunkFilename: '[id].js', clean: true },
    optimization: { minimize: false, concatenateModules: false, inlineExports: false, usedExports: false,
      splitChunks: { chunks: 'all', minSize: 20000, maxInitialRequests: Infinity,
        maxAsyncRequests: Infinity, cacheGroups: groupsFor({ test: 0, name: 0, chunks: 0 }) } },
  });
  compiler.hooks.invalid.tap('MemoryGateDiagnostics', (file, time) => {
    invalidations.push({ file, time, elapsedMs: performance.now() - wallStart });
  });
  let baseline;
  const nextBuild = phase => new Promise((resolve, reject) => {
    if (pending || unexpected) throw new Error(`Invalid watch state: ${unexpected}`);
    const timer = setTimeout(() => reject(new Error(`Build timeout: ${phase}`)), 600000);
    baseline = { wall: performance.now(), cpu: process.cpuUsage() };
    pending = { resolve: stats => { clearTimeout(timer); resolve(stats); },
      reject: error => { clearTimeout(timer); reject(error); } };
  });
  const capture = (stats, phase) => {
    const doneMemory = memory();
    const cpu = process.cpuUsage(baseline.cpu);
    const wallMs = performance.now() - baseline.wall;
    if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
    report.builds.push({ phase, wallMs, cpuSeconds: (cpu.user + cpu.system) / 1e6,
      cpuUserSeconds: cpu.user / 1e6, cpuSystemSeconds: cpu.system / 1e6,
      ...doneMemory, cacheGroupsMs: cacheGroupsMs(stats) });
  };
  const first = nextBuild('cold');
  watching = compiler.watch({ aggregateTimeout: 200, ignored: /[\\/](?:dist|node_modules|\.git)[\\/]/ }, (error, stats) => {
    const waiter = pending;
    pending = undefined;
    if (!waiter) { unexpected = error?.stack || `Unexpected compilation: ${JSON.stringify(invalidations.slice(-10))}; modified=${JSON.stringify([...(compiler.modifiedFiles || [])])}`; return; }
    if (error) waiter.reject(error);
    else if (!stats) waiter.reject(new Error('Missing stats'));
    else waiter.resolve(stats);
  });
  capture(await first, 'cold');
  for (let i = 0; i < 6; i++) {
    await delay(1000);
    const phase = `edit${i + 1}`;
    const next = nextBuild(phase);
    fs.writeFileSync(leaf, i % 2 === 0 ? edited : original);
    capture(await next, phase);
  }
  const idleStart = performance.now();
  for (let i = 1; i <= 20; i++) {
    while (performance.now() < idleStart + i * 500) {
      await delay(Math.max(1, Math.ceil(idleStart + i * 500 - performance.now())));
    }
    report.idleSamples.push({ ...memory(), idleMs: performance.now() - idleStart });
  }
  if (unexpected) throw new Error(unexpected);
  report.steadyRssMiB = median(report.idleSamples.slice(-5).map(x => x.rssMiB));
  if (process.platform === 'linux') report.steadyRssAnonMiB = median(report.idleSamples.slice(-5).map(x => x.rssAnonMiB));
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  try {
    if (watching) await new Promise((resolve, reject) => watching.close(e => e ? reject(e) : resolve()));
    fs.writeFileSync(leaf, original);
    if (compiler) await new Promise((resolve, reject) => compiler.close(e => e ? reject(e) : resolve()));
  } catch (error) { report.error = [report.error, error.stack].filter(Boolean).join('\n'); process.exitCode = 1; }
  report.peakRssMiB = process.resourceUsage().maxRSS / 1024;
  const cpu = process.cpuUsage(cpuStart);
  report.cpuSeconds = (cpu.user + cpu.system) / 1e6;
  report.wallMs = performance.now() - wallStart;
  report.success = !report.error && report.builds.length === 7 && report.idleSamples.length === 20;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  if (!report.success) { console.error(report.error || 'Incomplete launch'); process.exitCode = 1; }
}
