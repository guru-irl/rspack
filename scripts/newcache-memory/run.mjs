import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const [arm, phase, output] = process.argv.slice(2);
const root = path.resolve(process.env.PROJECT);
const { rspack } = await import(path.resolve(process.env.RSPACK_CORE));
const native = process.platform === 'darwin' ? createRequire(import.meta.url)('./memory.node') : null;
const started = performance.now();
const cpuStarted = process.cpuUsage();
const events = [], rounds = [], curve = [];
let current = {}, complete = false;
const checkpoint = () => {
  const cpu = process.cpuUsage(cpuStarted);
  return { wall_ms: performance.now() - started, cpu_ms: (cpu.user + cpu.system) / 1000,
    user_ms: cpu.user / 1000, sys_ms: cpu.system / 1000 };
};
function memory(gc = false) {
  if (gc) global.gc();
  const counters = native ? native.sample() : Object.fromEntries(
    fs.readFileSync('/proc/self/status', 'utf8').split('\n')
      .map(l => l.match(/^(VmHWM|VmRSS|RssAnon|RssFile):\s+(\d+) kB/))
      .filter(Boolean).map(m => [m[1], Number(m[2]) * 1024]));
  if (!native) counters.peak = counters.VmHWM;
  if (!counters.peak) throw new Error('Missing exact kernel peak');
  return { ...counters, heap_used: process.memoryUsage().heapUsed };
}
function disk(directory) {
  let bytes = 0, allocated_bytes = 0, files = 0;
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        try { const s = fs.statSync(file); bytes += s.size; allocated_bytes += s.blocks * 512; files++; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
  }
  walk(directory);
  return { bytes, allocated_bytes, files };
}
function manifest() {
  const entries = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else entries.push({ name: path.relative(path.join(root, 'dist'), file),
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
  }
  walk(path.join(root, 'dist'));
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
const longIdle = phase === 'watch';
const cacheLocation = path.join(root, 'cache');
const plugin = { apply(compiler) {
  compiler.hooks.infrastructureLog.tap('measure', (origin, type, args) => {
    events.push({ ...checkpoint(), origin, type, args }); return true;
  });
  compiler.hooks.compile.tap('measure', () => { current.compile = checkpoint(); });
  compiler.hooks.done.tap('measure', stats => {
    current.done = checkpoint();
    current.memory_done = memory(true);
    current.modules = stats.compilation.modules.size;
  });
} };
const compiler = rspack({
  name: 'parity', mode: 'development', context: root, entry: './src/index.js', devtool: false,
  output: { path: path.join(root, 'dist'), clean: false },
  module: { rules: [ { test: /\.css$/, type: 'css/auto' },
    { test: /\.js$/, include: path.join(root, 'src'), use: [path.join(root, 'loaders/tag-loader.cjs')] } ] },
  cache: { type: 'filesystem', cacheLocation, version: arm === 'p1' ? 'codec-measurement' : 'baseline-measurement',
    readonly: phase === 'readonly', buildDependencies: { harness: [import.meta.filename] },
    ...(longIdle ? { idleTimeout: 3600000, idleTimeoutForInitialStore: 3600000,
      idleTimeoutAfterLargeChanges: 3600000 } : {}) },
  experiments: { newCache: true }, infrastructureLogging: { level: 'log', debug: /rspack\./ },
  stats: 'none', plugins: [plugin],
});
const watchdog = setTimeout(() => { console.error('Measurement deadline'); process.exit(2); }, 900000);
process.on('exit', () => { if (!complete) process.exitCode = 2; });
const sampler = setInterval(() => curve.push({ ...checkpoint(), ...memory() }), 100);
function finish(stats) {
  if (!stats || stats.hasErrors()) throw new Error(stats?.toString({ all: false, errors: true }) || 'No stats');
  current.outputs = manifest();
  rounds.push(current);
}
const leaf = path.join(root, 'src/d0/m9.js');
const original = fs.readFileSync(leaf, 'utf8');
let watching;
if (phase === 'watch' || phase === 'edit') {
  const edits = phase === 'watch' ? 6 : 1;
  let resolveRound, rejectRound;
  let pending = new Promise((res, rej) => { resolveRound = res; rejectRound = rej; });
  watching = compiler.watch({ aggregateTimeout: 20 }, (error, stats) => error ? rejectRound(error) : resolveRound(stats));
  for (let edit = 0; edit <= edits; edit++) {
    finish(await pending);
    if (edit === edits) break;
    await delay(100);
    current = { edit, edit_start: checkpoint() };
    pending = new Promise((res, rej) => { resolveRound = res; rejectRound = rej; });
    fs.writeFileSync(leaf, original + `\nconsole.log('public synthetic edit ${edit + 1}');\n`);
  }
} else {
  finish(await new Promise((res, rej) => compiler.run((error, stats) => error ? rej(error) : res(stats))));
}
await delay(phase === 'seed' ? 30000 : 7000);
const end = checkpoint(), memory_end = memory(true), cache_end = disk(cacheLocation);
const beforeCloseEvents = events.length;
if (phase === 'watch' && events.some(e => /Stored cache|compaction|compact cache/.test(String(e.args)))) {
  throw new Error('Idle work ran in no-idle watch target');
}
if (watching) await new Promise((res, rej) => watching.close(error => error ? rej(error) : res()));
await new Promise((res, rej) => compiler.close(error => error ? rej(error) : res()));
const closed = checkpoint(), memory_closed = memory(true), cache_closed = disk(cacheLocation);
clearInterval(sampler);
if (events.some(e => /Resetting cache|Failed to .*cache|cache.*unavailable/i.test(String(e.args))) && phase !== 'seed') {
  throw new Error('Warm cache reset or failure');
}
if (events.some(e => /Failed to (?:encode|decode) cache entry/i.test(String(e.args)))) {
  throw new Error('Cache codec failure, not a sample');
}
if (!cache_closed.files) throw new Error('Empty cache');
if (phase === 'seed' && (!events.some(e => /Stored cache/.test(String(e.args))) ||
    !events.some(e => /Measurement idle complete/.test(String(e.args))))) {
  throw new Error('Seed did not complete persistence and idle compaction');
}
const compaction_passes = events.filter(e => String(e.args).includes('measurement compaction pass'));
const result = { arm, phase, rounds, end, memory_end, closed, memory_closed,
  cache_end, cache_closed, events, beforeCloseEvents, compaction_passes, curve };
fs.writeFileSync(output, JSON.stringify(result));
process.once('beforeExit', () => {
  result.memory_exit = memory();
  result.exit = checkpoint();
  fs.writeFileSync(output, JSON.stringify(result));
});
complete = true;
clearTimeout(watchdog);
console.log(JSON.stringify({ arm, phase, rounds: rounds.length, done: rounds[0].done, peak: memory_closed.peak }));
