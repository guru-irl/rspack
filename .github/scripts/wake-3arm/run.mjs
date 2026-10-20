import fs from 'node:fs';
import path from 'node:path';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import os from 'node:os';
import { rspack } from '../runtime/node_modules/@rspack/core/dist/index.js';
const [rootArg, resultArg] = process.argv.slice(2);
const root = path.resolve(rootArg);
const resultPath = path.resolve(resultArg);
const marks = {};
const mark = name => { marks[name] = Number(process.hrtime.bigint()) / 1e9; };
const mainTicks = () => {
  const fields = fs.readFileSync(`/proc/self/task/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(fields[11]) + Number(fields[12]);
};
const gc = [];
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gc.push({start: e.startTime, duration: e.duration, kind: e.detail.kind}); });
observer.observe({entryTypes: ['gc']});
globalThis.loaderCalls = {noop: 0, ast: 0, rewrite: 0};
let finishModulesCalls = 0, processAssetsCalls = 0;
let makeStartMs, makeEndMs;
mark('setupStart');
const compiler = rspack({
  mode: 'development', context: root, entry: './entry.js', cache: false, devtool: false, target: 'node',
  output: {path: path.join(root, 'out'), filename: 'bundle.cjs'},
  module: {rules: [
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
const cpuStart = process.cpuUsage();
mark('buildStart');
const timerNames = ['setImmediate', 'setTimeout', 'setInterval'];
const originalTimers = Object.fromEntries(timerNames.map(name => [name, globalThis[name]]));
const noTimer = () => undefined;
const fakeTimers = process.env.FAKE_TIMERS === '1';
if (fakeTimers) for (const name of timerNames) globalThis[name] = noTimer;
const start = performance.now();
const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => {
  if (fakeTimers && timerNames.some(name => globalThis[name] !== noTimer)) return reject(new Error('Timer replacement changed during build'));
  error ? reject(error) : resolve(stats);
}));
const buildMs = performance.now() - start;
if (fakeTimers) for (const name of timerNames) globalThis[name] = originalTimers[name];
mark('buildEnd');
const mainCpuMs = (mainTicks() - startTicks) * 10;
const processCpuUs = process.cpuUsage(cpuStart);
const peakRss = process.resourceUsage().maxRSS * 1024;
const steadyRss = process.memoryUsage().rss;
const diagnostics = stats.toJson({all: false, errors: true, warnings: true});
if (diagnostics.errors.length || diagnostics.warnings.length) throw new Error(JSON.stringify(diagnostics));
await new Promise(resolve => setImmediate(resolve));
observer.disconnect();
const makeGcMs = gc.reduce((sum, e) => sum + Math.max(0, Math.min(e.start + e.duration, makeEndMs) - Math.max(e.start, makeStartMs)), 0);
if (globalThis.loaderCalls.noop !== 60701 || globalThis.loaderCalls.ast !== 6000 || globalThis.loaderCalls.rewrite !== 3000) throw new Error('Unexpected loader counts');
const result = {fakeTimers, errors: diagnostics.errors.length, warnings: diagnostics.warnings.length, pid: process.pid, node: process.version, cpus: os.cpus().length, marks, buildMs, makeMs: makeEndMs - makeStartMs, mainCpuMs, processCpuUs, peakRss, steadyRss, makeGcMs, gc, loaderCalls: globalThis.loaderCalls, finishModulesCalls, processAssetsCalls};
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({...result, gc: undefined}));
await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
mark('closeEnd');
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
