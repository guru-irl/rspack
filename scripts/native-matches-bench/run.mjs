import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.dirname(fileURLToPath(import.meta.url));
const options = { arm: 'callback', mode: 'development', runs: '1', out: 'results.json' };
const allowed = new Set(['rspack', 'arm', 'mode', 'runs', 'out']);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].slice(2);
  if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
    throw new Error('Usage: node run.mjs [--rspack <package directory>] [--arm callback|native] [--mode development|production] [--runs <n>] [--out <file.json>]');
  }
  options[key] = args[i + 1];
}
if (!['callback', 'native'].includes(options.arm)) throw new Error('Invalid --arm');
if (!['development', 'production'].includes(options.mode)) throw new Error('Invalid --mode');
const runs = Number(options.runs);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
const require = createRequire(path.join(process.cwd(), 'package.json'));
const entry = options.rspack
  ? path.join(path.resolve(options.rspack), 'dist', 'index.js')
  : require.resolve('@rspack/core');
const core = await import(pathToFileURL(entry).href);
const { rspack } = core;
if (typeof rspack !== 'function') throw new Error('Selected package does not export rspack');
const src = path.join(root, 'src');
const leaf = path.join(src, 'packages', 'p000', 'm00000.js');
const original = fs.readFileSync(leaf);
const edited = Buffer.from('export const value = 999999;\n');
if (original.equals(edited)) throw new Error('Leaf is already edited; regenerate the fixture');
const out = path.resolve(options.out);
fs.mkdirSync(path.dirname(out), { recursive: true });
const report = {
  arm: options.arm, mode: options.mode, runs,
  host: {
    platform: process.platform, arch: process.arch, release: os.release(),
    cpuModel: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.cpus().length,
    node: process.version, rspack: core.rspackVersion ?? core.version ?? 'unknown',
    rayonNumThreads: process.env.RAYON_NUM_THREADS ?? null,
    tokioWorkerThreads: process.env.TOKIO_WORKER_THREADS ?? null,
    rspackEnvironment: Object.keys(process.env).filter(k => k.startsWith('RSPACK_')),
    loadavg: os.loadavg(),
  },
  records: [],
};
function baseline() {
  return { wall: performance.now(), cpu: process.cpuUsage(), resource: process.resourceUsage() };
}
function delta(start) {
  const cpu = process.cpuUsage(start.cpu);
  const resource = process.resourceUsage();
  return {
    wallMs: performance.now() - start.wall,
    cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    voluntaryContextSwitches: resource.voluntaryContextSwitches - start.resource.voluntaryContextSwitches,
    involuntaryContextSwitches: resource.involuntaryContextSwitches - start.resource.involuntaryContextSwitches,
  };
}
function groupsFor(counts) {
  const callback = options.arm === 'callback';
  const track = (selector, body) => (...args) => { counts[selector]++; return body(...args); };
  const groups = { defaultVendors: false };
  const priorities = Array.from({ length: 48 }, (_, i) => 3 + i * 2);
  for (let i = 0; i < 112; i++) {
    groups[`native${i}`] = {
      test: new RegExp(`[\\\\/]packages[\\\\/]p${String(i).padStart(3, '0')}[\\\\/]`),
      priority: priorities[i % 48], minSize: 1e12, minChunks: 2,
      chunks: 'all', reuseExistingChunk: true,
    };
  }
  const absent = /[\\/]packages[\\/]p999[\\/]/;
  for (let i = 0; i < 6; i++) {
    groups[`function${i}`] = {
      priority: 95, chunks: 'all', minChunks: 2, minSize: 1e12,
      test: callback ? track('test', (m, info) => {
        const hasChunks = i !== 0 || info.chunkGraph.getModuleChunks(m).length > 0;
        return hasChunks && absent.test(m.resource || '');
      }) : absent,
    };
  }
  groups.largeName = {
    priority: 93, test: /[\\/]packages[\\/]/, chunks: 'all', minChunks: 2, minSize: 1e12,
    name: callback ? track('name', () => 'package') : 'package',
  };
  groups.rareName = {
    priority: 93, test: /[\\/]m0000[01]\.js$/, chunks: 'all', minChunks: 2, minSize: 1e12,
    name: callback ? track('name', () => 'rare') : 'rare',
  };
  groups.default = {
    priority: -20, minChunks: 2, minSize: 20000, reuseExistingChunk: true,
    // Unnamed async chunks must pass. No generated chunk is named 'never'.
    chunks: callback ? track('chunks', c => c.name !== 'never') : 'all',
  };
  return groups;
}
async function runOnce(run) {
  const counts = { test: 0, chunks: 0, name: 0 };
  let splitStart;
  let splitChunks;
  const compiler = rspack({
    context: src, mode: options.mode, devtool: false, cache: false,
    entry: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`entry${i}`, `./entry${i}.js`])),
    output: { path: path.join(root, 'dist', options.arm), filename: '[name].js', chunkFilename: '[id].js', clean: true },
    optimization: {
      minimize: false, concatenateModules: false, inlineExports: false, usedExports: false,
      splitChunks: { chunks: 'all', minSize: 20000, maxInitialRequests: Infinity, maxAsyncRequests: Infinity, cacheGroups: groupsFor(counts) },
    },
    plugins: [{ apply(c) {
      c.hooks.thisCompilation.tap('FixtureMetrics', compilation => {
        counts.test = counts.chunks = counts.name = 0;
        splitStart = splitChunks = undefined;
        compilation.hooks.afterOptimizeModules.tap({ name: 'FixtureBefore', stage: -100000 }, () => { splitStart = baseline(); });
        compilation.hooks.optimizeTree.tap({ name: 'FixtureAfter', stage: 100000 }, () => {
          if (splitStart) splitChunks = delta(splitStart);
        });
      });
    } }],
  });
  let watching;
  let waiter;
  let phase = 'cold';
  let start = baseline();
  const nextBuild = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${phase} build`)), 600000);
    waiter = {
      resolve: stats => { clearTimeout(timer); resolve(stats); },
      reject: error => { clearTimeout(timer); reject(error); },
    };
  });
  const capture = stats => {
    const metrics = delta(start);
    if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
    if (!splitChunks) throw new Error('SplitChunks bracket hooks did not run');
    const record = {
      run, build: phase, compileMs: stats.endTime - stats.startTime, ...metrics,
      splitChunks, callbacks: { ...counts },
      modules: stats.compilation.modules.size, chunks: stats.compilation.chunks.size,
    };
    record.hashes = Object.fromEntries(stats.compilation.getAssets().map(({ name, source }) => [name, crypto.createHash('sha256').update(source.buffer()).digest('hex')]).sort(([a], [b]) => a.localeCompare(b)));
    if (process.env.MEASURE_FOOTPRINT) {
      global.gc?.(); global.gc?.();
      const result = spawnSync('/usr/bin/footprint', ['--noCategories', '-f', 'bytes', '-p', String(process.pid)], { encoding: 'utf8', timeout: 30000 });
      const text = (result.stdout || '') + (result.stderr || '');
      fs.writeFileSync(out.replace(/\.json$/, `.${phase}.footprint.txt`), text);
      if (result.error || result.status !== 0) throw result.error || new Error(`footprint failed ${result.status}: ${text}`);
      const current = text.match(/phys_footprint:\s*([\d,]+) B/);
      const peak = text.match(/phys_footprint_peak:\s*([\d,]+) B/);
      if (!current || !peak) throw new Error('Cannot parse physical footprint');
      record.steadyFootprint = Number(current[1].replaceAll(',', ''));
      record.peakFootprint = Number(peak[1].replaceAll(',', ''));
    }
    if (process.env.RSPACK_LIVE_HEAP_LOG) {
      const lines = fs.readFileSync(process.env.RSPACK_LIVE_HEAP_LOG, 'utf8').trim().split('\n');
      const complete = lines.filter(line => /^\d+\t\d+\t\d+\t-?\d+\t-?\d+$/.test(line));
      if (!complete.length) throw new Error('Missing live heap samples');
      const row = complete.at(-1).split('\t').map(Number);
      if (Date.now() - row[0] > 250) throw new Error('Live heap sample is stale');
      record.liveHeap = { epochMs: row[0], liveBytes: row[3], peakBytes: row[4] };
      record.jsMemory = process.memoryUsage();
    }
    report.records.push(record);
    console.log(`${options.arm} run=${run} ${phase} compile=${record.compileMs}ms wall=${record.wallMs.toFixed(1)}ms split=${splitChunks.wallMs.toFixed(1)}ms callbacks=${JSON.stringify(record.callbacks)} cs=${record.voluntaryContextSwitches}/${record.involuntaryContextSwitches} modules=${record.modules} chunks=${record.chunks}`);
  };
  try {
    const first = nextBuild();
    watching = compiler.watch({ aggregateTimeout: 0 }, (error, stats) => {
      const pending = waiter;
      waiter = undefined;
      if (!pending) return;
      if (error) pending.reject(error);
      else if (!stats) pending.reject(new Error('Missing compilation stats'));
      else pending.resolve(stats);
    });
    capture(await first);
    for (const [build, content] of [['rebuild', edited], ['revert', original]]) {
      phase = build;
      const next = nextBuild();
      start = baseline();
      fs.writeFileSync(leaf, content);
      capture(await next);
    }
  } finally {
    try {
      if (watching) await new Promise((resolve, reject) => watching.close(error => error ? reject(error) : resolve()));
    } finally {
      fs.writeFileSync(leaf, original);
      await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
    }
  }
}
try {
  for (let run = 1; run <= runs; run++) await runOnce(run);
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}
