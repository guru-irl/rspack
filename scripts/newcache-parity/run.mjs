import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const [arm, phase, output] = process.argv.slice(2);
const root = path.resolve(process.env.PROJECT);
const isNew = arm !== 'L';
const counted = process.env.COUNT === '1';
const { rspack } = await import(path.resolve(process.env.RSPACK_CORE));
const footprint = process.platform === 'darwin' ? require('./memory.node') : null;
const start = performance.now();
const cpuStart = process.cpuUsage();
const events = [];
const rounds = [];
let current = { counts: {}, timestamps: {} };
let complete = false;
let sawStored = false;
let resolveStored;
const stored = new Promise(r => { resolveStored = r; });
const watchdog = setTimeout(() => {
  console.error('Measurement deadline exceeded');
  process.exit(2);
}, 15 * 60 * 1000);
process.on('exit', () => {
  if (!complete) {
    console.error('Incomplete measurement process');
    process.exitCode = 2;
  }
});
function checkpoint() {
  const cpu = process.cpuUsage(cpuStart);
  return { wall_ms: performance.now() - start, user_ms: cpu.user / 1000, sys_ms: cpu.system / 1000 };
}
function memory() {
  if (!global.gc) throw new Error('--expose-gc is required');
  global.gc();
  const m = process.memoryUsage();
  const native = footprint ? footprint.sample() : Object.fromEntries(
    fs.readFileSync('/proc/self/status', 'utf8').split('\n')
      .map(l => l.match(/^(VmHWM|VmRSS|RssAnon):\s+(\d+) kB/))
      .filter(Boolean).map(match => [match[1], Number(match[2]) * 1024]),
  );
  return { ...native, heap_used: m.heapUsed, external: m.external, rss: m.rss };
}
function disk(directory) {
  if (!fs.existsSync(directory)) return { bytes: 0, allocated_bytes: 0, files: 0 };
  let bytes = 0, allocated = 0, files = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        try {
          const s = fs.statSync(file);
          bytes += s.size; allocated += s.blocks * 512; files++;
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
  }
  walk(directory);
  return { bytes, allocated_bytes: allocated, files };
}
function manifest() {
  const result = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        const data = fs.readFileSync(file);
        result.push({ name: path.relative(path.join(root, 'dist'), file), bytes: data.length,
          sha256: crypto.createHash('sha256').update(data).digest('hex') });
      }
    }
  }
  walk(path.join(root, 'dist'));
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
const inc = key => { current.counts[key] = (current.counts[key] || 0) + 1; };
const stamp = key => { current.timestamps[key] = checkpoint(); };
const cacheLocation = path.join(root, 'cache');
const plugin = {
  apply(compiler) {
    compiler.hooks.infrastructureLog.tap('measure', (origin, type, args) => {
      events.push({ ...checkpoint(), origin, type, args });
      if (String(args).includes('Stored cache')) { sawStored = true; resolveStored(); }
      // Log capture only, so console transport does not add noise.
      return true;
    });
    compiler.hooks.compile.tap('measure', () => stamp('compile'));
    compiler.hooks.make.tap('measure', () => stamp('make'));
    compiler.hooks.finishMake.tap('measure', () => stamp('finishMake'));
    compiler.hooks.emit.tap('measure', () => stamp('emit'));
    compiler.hooks.thisCompilation.tap('measure', compilation => {
      compilation.hooks.finishModules.tap('measure', () => stamp('finishModules'));
      compilation.hooks.seal.tap('measure', () => stamp('seal'));
      if (counted) {
        compilation.hooks.buildModule.tap('measure', () => inc('built'));
        compilation.hooks.stillValidModule.tap('measure', () => inc('stillValid'));
      }
    });
    if (counted) compiler.hooks.normalModuleFactory.tap('measure', nmf => {
      for (const name of ['factorize', 'resolve', 'beforeResolve', 'afterResolve', 'createModule']) {
        nmf.hooks[name].tap('measure', () => { inc(name); });
      }
    });
    compiler.hooks.done.tap('measure', stats => {
      stamp('done');
      current.modules = stats.compilation.modules.size;
      current.memory_done = memory();
    });
  },
};
const config = {
  name: 'parity', mode: 'development', context: root, entry: './src/index.js', devtool: false,
  output: { path: path.join(root, 'dist'), clean: false },
  module: { rules: [
    { test: /\.css$/, type: 'css/auto' },
    { test: /\.js$/, include: path.join(root, 'src'), use: [path.join(root, 'loaders/tag-loader.cjs')] },
  ] },
  cache: isNew
    ? { type: 'filesystem', cacheLocation, buildDependencies: { harness: [import.meta.filename] } }
    : { type: 'persistent', storage: { type: 'filesystem', location: cacheLocation }, buildDependencies: [import.meta.filename] },
  experiments: isNew ? { newCache: process.env.NO_RESOLVER === '1' ? { resolver: false } : true } : {},
  infrastructureLogging: { level: 'log', debug: /rspack\./ }, stats: 'none', plugins: [plugin],
};
const compiler = rspack(config);
const close = () => new Promise((res, rej) => compiler.close(e => e ? rej(e) : res()));
function validate(stats) {
  if (!stats || stats.hasErrors()) throw new Error(stats?.toString({ all: false, errors: true }) || 'No stats');
}
function finishRound(stats) {
  validate(stats);
  current.cache_done = disk(cacheLocation);
  current.outputs = manifest();
  if (counted) {
    current.restored_module_hooks = current.counts.stillValid || 0;
    current.restored_graph_inferred = !isNew && (current.counts.built || 0) === 0 ? current.modules : 0;
  }
  rounds.push(current);
}
const watch = phase === 'watch1' || phase === 'watch5';
if (watch) {
  const edits = phase === 'watch1' ? 1 : 5;
  const leaf = path.join(root, 'src/d0/m9.js');
  const original = fs.readFileSync(leaf, 'utf8');
  let resolveRound, rejectRound;
  let pending = new Promise((res, rej) => { resolveRound = res; rejectRound = rej; });
  const watching = compiler.watch({ aggregateTimeout: 50 }, (error, stats) => {
    if (error) rejectRound(error); else resolveRound(stats);
  });
  for (let i = 0; i <= edits; i++) {
    finishRound(await pending);
    if (i === edits) break;
    // Allow beginIdle's generation step to run, but don't wait for disk persistence.
    await delay(100);
    current = { counts: {}, timestamps: {}, edit: i + 1, edit_start: checkpoint() };
    pending = new Promise((res, rej) => { resolveRound = res; rejectRound = rej; });
    fs.writeFileSync(leaf, original + `\n// public synthetic edit ${i + 1}\n`);
  }
  await new Promise((res, rej) => watching.close(e => e ? rej(e) : res()));
} else {
  const stats = await new Promise((res, rej) => compiler.run((e, s) => e ? rej(e) : res(s)));
  finishRound(stats);
}
const idleStart = checkpoint();
if (phase === 'idle') await delay(65000);
if (phase === 'cold' && isNew) {
  await Promise.race([stored, delay(120000).then(() => { throw new Error('No persistence completion event'); })]);
}
const end = checkpoint();
const memoryEnd = memory();
const cacheEnd = disk(cacheLocation);
const closeStart = checkpoint();
await close(); // Includes the legacy storage flush; success is mandatory before seeding warm phases.
const closed = checkpoint();
const result = { arm, phase, counted, no_resolver: process.env.NO_RESOLVER === '1', pid: process.pid,
  rounds, idle_start: idleStart, end, memory_end: memoryEnd, cache_end: cacheEnd,
  close_start: closeStart, closed, memory_closed: memory(), cache_closed: disk(cacheLocation), sawStored, events };
if (events.some(e => /Failed to .*cache|cache.*unavailable/i.test(String(e.args)))) throw new Error('Cache persistence failure in events');
fs.writeFileSync(output, JSON.stringify(result));
complete = true;
clearTimeout(watchdog);
console.log(JSON.stringify({ arm, phase, done_ms: rounds[0].timestamps.done.wall_ms, closed_ms: closed.wall_ms }));
