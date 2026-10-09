import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PerformanceObserver, performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { rspack } = require('@rspack/core');
const picomatch = require('picomatch');
const [arm, variant, phase, tag, control] = process.argv.slice(2);
const fixture = path.resolve('fixture');
const cacheDir = path.resolve('cache', `${variant}-${arm}-${tag}`);
const counts = { use: 0, use_nonempty: 0, include: 0, include_true: 0, include_false: 0, transform: 0, load: 0, build: 0, valid: 0 };
const state = globalThis.syntheticLoaderState = { active: 0, max: 0, started: { transform: 0, load: 0 }, completed: { transform: 0, load: 0 }, originals: {}, identities: Object.fromEntries(['transform', 'load'].map(kind => [kind, { plugins: new WeakSet(), hooks: new WeakSet(), queries: new WeakSet(), plugin_count: 0, hook_count: 0, query_count: 0 }])) };
const plugins = [];
let resolveFilterReads = 0;
let resolveHandlerCalls = 0;
if (arm !== 'none') {
  const packageRoot = path.resolve('variants', arm, 'package');
  const { createUnplugin } = await import(pathToFileURL(path.join(packageRoot, 'dist/index.mjs')));
  const files = fs.readdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  for (const kind of ['transform', 'load']) {
    const file = files.find(f => f.endsWith(`rspack/loaders/${kind}.mjs`));
    if (!file) throw new Error(`Cannot find ${kind} loader`);
    state.originals[kind] = (await import(pathToFileURL(path.join(packageRoot, 'dist', file)))).default;
  }
  const filter = { id: { include: variant === 'broad' ? ['**/*.tsx', '**/src/**/*.ts'] : ['**/routes/**'], exclude: ['**/node_modules/**', '**/excluded/**'] } };
  if (arm === 'RX') for (const key of ['include', 'exclude']) filter.id[key] = filter.id[key].map(glob => picomatch.makeRe(glob, { dot: true }));
  const definition = { name: 'synthetic-filter', transform: { filter, handler(code) { counts.transform++; return code; } }, load: { filter, handler() { counts.load++; return null; } } };
  if (control === 'resolve') definition.resolveId = { get filter() { resolveFilterReads++; return { id: { include: ['**/*.ts', /^\.\//] } }; }, handler() { resolveHandlerCalls++; return null; } };
  const plugin = createUnplugin(() => definition).rspack();
  const descriptor = item => {
    const kind = item.loader.endsWith('/transform.mjs') ? 'transform' : item.loader.endsWith('/load.mjs') ? 'load' : null;
    if (!kind) throw new Error('Unexpected synthetic plugin loader');
    return { ...item, loader: path.resolve(`${kind}-wrapper.mjs`) };
  };
  plugins.push({ apply(compiler) {
    plugin.apply(compiler);
    const wrapRules = rules => { for (const rule of rules) {
      if (typeof rule.use === 'function') {
        const original = rule.use;
        rule.use = function (...args) { counts.use++; const result = original.apply(this, args); if (result.length) counts.use_nonempty++; return result.map(descriptor); };
      } else if (Array.isArray(rule.use)) rule.use = rule.use.map(descriptor);
      if (typeof rule.include === 'function') {
        const original = rule.include;
        rule.include = function (...args) { counts.include++; const result = original.apply(this, args); counts[result ? 'include_true' : 'include_false']++; return result; };
      }
      if (rule.rules) wrapRules(rule.rules);
    } };
    wrapRules(compiler.options.module.rules);
  } });
}
if (phase === 'cold' || phase === 'watch') {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  if (fs.readdirSync(cacheDir).length) throw new Error('Cold cache is not empty');
} else if (!fs.existsSync(cacheDir) || !fs.readdirSync(cacheDir).length) throw new Error('Warm cache missing');
let start;
let cpuStart;
let endpoint;
let endTime;
const timestamps = {};
const concurrency = [];
const gc = [];
const collect = entries => { for (const e of entries) gc.push({ start_ms: e.startTime, duration_ms: e.duration, kind: e.detail.kind }); };
const observer = new PerformanceObserver(list => collect(list.getEntries()));
observer.observe({ entryTypes: ['gc'] });
const anon = () => Number(fs.readFileSync('/proc/self/status', 'utf8').match(/^RssAnon:\s+(\d+)/m)[1]) / 1024;
plugins.push({ apply(compiler) {
  for (const hook of ['make', 'finishMake', 'afterCompile']) compiler.hooks[hook].tap({ name: 'SyntheticMeasure', stage: -10000 }, () => { timestamps[hook] = performance.now() - start; });
  compiler.hooks.thisCompilation.tap('SyntheticMeasure', compilation => {
    compilation.hooks.buildModule.tap('SyntheticMeasure', () => counts.build++);
    compilation.hooks.stillValidModule.tap('SyntheticMeasure', () => counts.valid++);
  });
  compiler.hooks.done.tap({ name: 'SyntheticMeasure', stage: 10000 }, () => {
    endTime = performance.now();
    const cpu = process.cpuUsage(cpuStart);
    timestamps.done = endTime - start;
    endpoint = { wall_ms: endTime - start, user_ms: cpu.user / 1000, sys_ms: cpu.system / 1000, cpu_ms: (cpu.user + cpu.system) / 1000, end_anon_mib: anon(), heap: v8.getHeapStatistics(), spaces: v8.getHeapSpaceStatistics(), memory: process.memoryUsage() };
    console.log(JSON.stringify({ event: 'endpoint', end_anon_mib: endpoint.end_anon_mib }));
  });
} });
const config = { mode: 'development', context: fixture, entry: './src/index.ts', devtool: false, output: { path: path.resolve('output'), filename: 'bundle.js' }, optimization: { concatenateModules: false, minimize: false }, module: { rules: [{ test: /\.ts$/, type: 'javascript/auto' }] }, plugins, cache: { type: 'persistent', storage: { type: 'filesystem', directory: cacheDir }, buildDependencies: [path.resolve('run.mjs'), path.resolve('loader-wrapper.mjs')] }, experiments: { newCache: true }, infrastructureLogging: { level: 'error' }, stats: 'none' };
console.log(JSON.stringify({ event: 'start', pid: process.pid, arm, variant, phase, exec_argv: process.execArgv }));
start = performance.now(); cpuStart = process.cpuUsage();
const interval = variant === 'broad' ? setInterval(() => concurrency.push({ ms: performance.now() - start, active: state.active }), 50) : null;
const compiler = rspack(config);
if (phase === 'watch') {
  const points = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const editPath = path.join(fixture, 'src/routes/m0.ts');
  const original = fs.readFileSync(editPath, 'utf8');
  let pending;
  let rejectPending;
  const nextBuild = () => new Promise((resolve, reject) => { pending = resolve; rejectPending = reject; });
  const initialPromise = nextBuild();
  const watcher = compiler.watch({ aggregateTimeout: 20 }, (error, stats) => {
    if (error || stats.hasErrors()) return rejectPending(error ?? new Error(stats.toString({ all: false, errors: true })));
    if (!pending) return rejectPending(new Error('Unexpected extra watch build'));
    const resolve = pending;
    pending = null;
    resolve(stats);
  });
  const snapshot = () => ({ anon_mib: anon(), memory: process.memoryUsage(), heap: v8.getHeapStatistics(), spaces: v8.getHeapSpaceStatistics() });
  const record = async (stats, index, before) => {
    await new Promise(resolve => setImmediate(resolve));
    const output = fs.readFileSync(path.resolve('output/bundle.js'));
    const work = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value - (before[key] ?? 0)]));
    if (index === 0 && work.build !== 60001) throw new Error('Invalid initial watch build');
    if (index > 0 && work.build < 1) throw new Error('Watch edit did not rebuild');
    if (state.active) throw new Error('Unfinished watch loaders');
    const events = gc.filter(e => e.start_ms >= start && e.start_ms < endTime);
    const kinds = {};
    for (const event of events) { const key = String(event.kind); kinds[key] ??= { count: 0, duration_ms: 0 }; kinds[key].count++; kinds[key].duration_ms += event.duration_ms; }
    points.push({ index, ...endpoint, counts: work, gc: kinds, output_sha256: crypto.createHash('sha256').update(output).digest('hex'), ...snapshot() });
  };
  try {
    await record(await initialPromise, 0, {});
    await wait(10000);
    const initialIdle = snapshot();
    for (let index = 1; index <= 5; index++) {
      if (index > 1) await wait(3000);
      const before = { ...counts };
      const promise = nextBuild();
      start = performance.now(); cpuStart = process.cpuUsage();
      fs.writeFileSync(editPath, index % 2 ? original.replace('= 1;', '= 2;') : original);
      await record(await promise, index, before);
    }
    await wait(10000);
    const finalIdle = snapshot();
    global.gc(); global.gc();
    const postGc = snapshot();
    if (interval) clearInterval(interval);
    collect(observer.takeRecords()); observer.disconnect();
    const identity = Object.fromEntries(Object.entries(state.identities).map(([kind, value]) => [kind, { plugin_count: value.plugin_count, hook_count: value.hook_count, query_count: value.query_count }]));
    console.log(JSON.stringify({ event: 'result', arm, variant, phase, tag, exec_argv: process.execArgv, wall_ms: points[0].wall_ms, end_anon_mib: finalIdle.anon_mib, points, initial_idle: initialIdle, final_idle: finalIdle, post_gc: postGc, identity, loader: { started: state.started, completed: state.completed }, counts, node_options: process.env.NODE_OPTIONS ?? '' }));
  } finally {
    await new Promise((resolve, reject) => watcher.close(error => error ? reject(error) : resolve()));
    fs.writeFileSync(editPath, original);
  }
  process.exit(0);
}
const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)));
if (interval) clearInterval(interval);
if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
await new Promise(resolve => setImmediate(resolve));
collect(observer.takeRecords()); observer.disconnect();
if (state.active !== 0) throw new Error('Unfinished loaders at endpoint');
if (phase === 'warm' && (counts.build !== 0 || counts.valid !== 60001)) throw new Error(`Invalid warm restore: ${JSON.stringify(counts)}`);
if (phase === 'cold' && counts.build !== 60001) throw new Error('Unexpected cold build count');
const expected = arm === 'none' || phase === 'warm' ? 0 : variant === 'broad' ? 60001 : 1800;
for (const kind of ['load', 'transform']) {
  if (counts[kind] !== expected || state.started[kind] !== expected || state.completed[kind] !== expected) throw new Error(`Loader work mismatch: ${kind}`);
}
const attachments = [];
for (const module of stats.compilation.modules) {
  const id = module.identifier();
  const resource = module.nameForCondition?.();
  if (resource) attachments.push([path.relative(fixture, resource), id.includes('transform-wrapper.mjs'), id.includes('load-wrapper.mjs')]);
}
attachments.sort((a, b) => a[0].localeCompare(b[0]));
const selected = attachments.filter(row => row[1] || row[2]).length;
const expectedAttached = arm === 'none' ? 0 : variant === 'broad' ? 60001 : 1800;
if (selected !== expectedAttached) throw new Error(`Attachment mismatch ${selected} != ${expectedAttached}`);
const output = fs.readFileSync(path.resolve('output/bundle.js'));
const inWindow = gc.filter(e => e.start_ms >= start && e.start_ms < endTime);
const gcSummary = {};
for (const e of inWindow) { const key = String(e.kind); gcSummary[key] ??= { count: 0, duration_ms: 0 }; gcSummary[key].count++; gcSummary[key].duration_ms += e.duration_ms; }
const phaseSplit = { setup_ms: timestamps.make, make_ms: timestamps.finishMake - timestamps.make, compile_ms: timestamps.afterCompile - timestamps.finishMake, emit_ms: timestamps.done - timestamps.afterCompile };
const identity = Object.fromEntries(Object.entries(state.identities).map(([kind, value]) => [kind, { plugin_count: value.plugin_count, hook_count: value.hook_count, query_count: value.query_count }]));
for (const kind of ['load', 'transform']) {
  const expectedIdentities = phase === 'warm' ? 0 : 1;
  if (identity[kind].plugin_count !== expectedIdentities || identity[kind].hook_count !== expectedIdentities) throw new Error('Loader plugin/hook identity is not stable');
}
const result = { event: 'result', control: control ?? null, identity, arm, variant, phase, tag, node_options: process.env.NODE_OPTIONS ?? '', exec_argv: process.execArgv, resolve_filter_reads: resolveFilterReads, resolve_handler_calls: resolveHandlerCalls, ...endpoint, counts, timestamps, phase_split: phaseSplit, gc: gcSummary, gc_events: inWindow, loader: { max_exact: state.max, started: state.started, completed: state.completed, samples: concurrency }, attachment_sha256: crypto.createHash('sha256').update(JSON.stringify(attachments)).digest('hex'), attached_modules: selected, output_sha256: crypto.createHash('sha256').update(output).digest('hex') };
if (control === 'gc') {
  global.gc(); global.gc();
  result.post_gc = { heap: v8.getHeapStatistics(), spaces: v8.getHeapSpaceStatistics(), anon_mib: anon() };
}
console.log(JSON.stringify(result));
await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
