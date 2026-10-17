import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import os from 'node:os';
import v8 from 'node:v8';
const memorySnapshot = () => {
  const heap = v8.getHeapStatistics();
  const memory = process.memoryUsage();
  return {v8: Object.fromEntries(['used_heap_size', 'total_heap_size', 'total_physical_size', 'malloced_memory', 'external_memory'].map(key => [key, heap[key]])), process: memory, nativeEstimate: memory.rss - heap.total_physical_size};
};
import { createRequire } from 'node:module';
import {rules, verifyDiagnostic} from '../cold-screen/layout.mjs';
const armManifest = JSON.parse(fs.readFileSync(process.env.ARM_MANIFEST));
const arm = armManifest[process.env.ARM];
if (!arm) throw new Error('Missing arm manifest');
const armRequire = createRequire(path.join(arm.dir, 'package.json'));
const {rspack} = armRequire(arm.name);
const cell = process.env.CELL || null;
const diagnostic = process.env.DIAGNOSTIC === '1';
const [rootArg, resultArg] = process.argv.slice(2);
const root = path.resolve(rootArg);
const resultPath = path.resolve(resultArg);
const marks = {};
const mark = name => { marks[name] = Number(process.hrtime.bigint()) / 1e9; };
const bindingPath = fs.realpathSync(process.env.BINDING_PATH);
const require = createRequire(import.meta.url);
const loadedBindings = Object.keys(require.cache).filter(file => path.basename(file).startsWith('rspack.') && file.endsWith('.node'));
if (loadedBindings.length !== 1) throw new Error(`Expected one loaded native binding, found ${JSON.stringify(loadedBindings)}`);
const loadedBindingPath = fs.realpathSync(loadedBindings[0]);
if (loadedBindingPath !== bindingPath) throw new Error(`Wrong loaded binding: ${loadedBindingPath}`);
const bindingSha256 = createHash('sha256').update(fs.readFileSync(loadedBindingPath)).digest('hex');
if (bindingSha256 !== process.env.EXPECTED_BINDING_SHA256) throw new Error('Loaded binding does not match its arm manifest');
const mappedBinding = process.platform === 'linux' ? fs.readFileSync('/proc/self/maps', 'utf8').split('\n').filter(line => line.endsWith(` ${loadedBindingPath}`)) : [];
if (process.platform === 'linux' && !mappedBinding.length) throw new Error('Expected binding is not mapped into this process');
const bindingIdentity = {loadedBindingPath, bindingSha256, verifiedInRequireCache: true, verifiedInMaps: process.platform === 'linux', mappedSegments: mappedBinding.length};
const mainTicks = () => {
  if (process.platform !== 'linux') return null;
  const fields = fs.readFileSync(`/proc/self/task/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(fields[11]) + Number(fields[12]);
};
const gc = [];
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gc.push({start: e.startTime, duration: e.duration, kind: e.detail.kind}); });
observer.observe({entryTypes: ['gc']});
globalThis.loaderCalls = {noop: 0, ast: 0, rewrite: 0};
if (diagnostic) {
  globalThis.loaderTraces = new Map();
  globalThis.ruleCalls = {include: 0, use: 0};
}
let finishModulesCalls = 0, processAssetsCalls = 0;
let makeStartMs, makeEndMs;
mark('setupStart');
const compiler = rspack({
  mode: 'development', context: root, entry: './entry.js', cache: false, devtool: false, target: 'node',
  output: {path: path.join(root, 'out'), filename: 'bundle.cjs'},
  module: {rules: cell ? rules(root, cell, diagnostic) : [
    {test: /\.ts$/, use: {loader: 'builtin:swc-loader', options: {jsc: {parser: {syntax: 'typescript'}}}}},
    {test: /[\\/]m\d*0\.js$/, use: path.join(root, 'ast.cjs')},
    {test: /[\\/]m(?:\d*(?:05|25|45|65|85)|5)\.js$/, use: path.join(root, 'rewrite.cjs')},
    {test: /\.[jt]s$/, enforce: 'post', use: {loader: path.join(root, 'noop.cjs'), options: {generic: true}}}
  ]},
  optimization: {minimize: false, concatenateModules: false, usedExports: false, moduleIds: 'named', chunkIds: 'named'},
  plugins: [{apply(compiler) {
    compiler.hooks.make.tap({name: 'Measure', stage: -100000}, () => { mark('makeStart'); makeStartMs = performance.now(); });
    compiler.hooks.finishMake.tap({name: 'Measure', stage: 100000}, () => { mark('makeEnd'); makeEndMs = performance.now(); });
    compiler.hooks.compilation.tap('GenericHooks', compilation => {
      compilation.hooks.finishModules.tap('GenericHooks', () => { finishModulesCalls++; mark('finishModules'); });
      compilation.hooks.processAssets.tap('GenericHooks', () => { processAssetsCalls++; mark('processAssets'); });
    });
  }}]
});
const startTicks = mainTicks();
const threadStart = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null;
const cpuStart = process.cpuUsage();
mark('buildStart');
const start = performance.now();
const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)));
const buildMs = performance.now() - start;
mark('buildEnd');
const threadCpuUs = threadStart ? process.threadCpuUsage(threadStart) : null;
const mainCpuMs = process.platform === 'linux' ? (mainTicks() - startTicks) * 1000 / Number(process.env.CLOCK_TICKS) : threadCpuUs ? (threadCpuUs.user + threadCpuUs.system) / 1000 : null;
const processCpuUs = process.cpuUsage(cpuStart);
const peakRss = process.resourceUsage().maxRSS * 1024;
const endSnapshot = memorySnapshot();
const steadyRss = endSnapshot.process.rss;
const errorCount = stats.compilation.errors.length;
const warningCount = stats.compilation.warnings.length;
if (stats.hasErrors()) throw new Error(stats.toString({all: false, errors: true, warnings: true}));
await new Promise(resolve => setImmediate(resolve));
const buildEnd = start + buildMs;
for (const e of observer.takeRecords()) gc.push({start: e.startTime, duration: e.duration, kind: e.detail.kind});
const buildGc = gc.filter(e => e.start >= start && e.start <= buildEnd);
const gcActivity = {count: buildGc.length, durationMs: buildGc.reduce((sum, e) => sum + e.duration, 0), byKind: {}};
for (const e of buildGc) {
  const value = gcActivity.byKind[e.kind] ??= {count: 0, durationMs: 0};
  value.count++;
  value.durationMs += e.duration;
}
observer.disconnect();
const makeGcMs = gc.reduce((sum, e) => sum + Math.max(0, Math.min(e.start + e.duration, makeEndMs) - Math.max(e.start, makeStartMs)), 0);
if (!cell && (globalThis.loaderCalls.noop !== 60701 || globalThis.loaderCalls.ast !== 6000 || globalThis.loaderCalls.rewrite !== 3000)) throw new Error('Unexpected loader counts');
const diagnosticCounts = diagnostic ? verifyDiagnostic(cell) : null;
const moduleCount = stats.compilation.modules.size;
if (moduleCount !== 60701) throw new Error(`Unexpected module count: ${moduleCount}`);
const outputFiles = [];
const outputRoot = path.join(root, 'out');
function hashFiles(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) hashFiles(file);
    else outputFiles.push({name: path.relative(outputRoot, file).split(path.sep).join('/'), bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  }
}
hashFiles(outputRoot);
if (!outputFiles.length) throw new Error('No emitted files');
const result = {cell, diagnostic, diagnosticCounts, moduleCount, warningCount, errorCount, threadCpuUs, mainCpuMethod: process.platform === 'linux' ? 'proc-task-stat' : threadCpuUs ? 'process.threadCpuUsage' : 'unavailable', bindingIdentity, bindingSha256, outputFiles, pid: process.pid, node: process.version, cpus: os.cpus().length, marks, buildMs, makeMs: makeEndMs - makeStartMs, mainCpuMs, processCpuUs, peakRss, steadyRss, snapshots: {end: endSnapshot}, gcActivity, makeGcMs, gc, loaderCalls: globalThis.loaderCalls, finishModulesCalls, processAssetsCalls};
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({...result, gc: undefined}));
await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
mark('closeEnd');
result.snapshots.close = memorySnapshot();
result.closeRss = result.snapshots.close.process.rss;
if (typeof globalThis.gc !== 'function') throw new Error('Explicit GC is required');
globalThis.gc();
await new Promise(resolve => setTimeout(resolve, 200));
result.snapshots.postGc = memorySnapshot();
result.idleRss = result.snapshots.postGc.process.rss;
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
