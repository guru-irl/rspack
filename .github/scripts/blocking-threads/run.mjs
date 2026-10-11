import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(path.join(path.resolve(process.env.CORE_ROOT), 'package.json'));
const { rspack } = require('@rspack/core');
const version = require('@rspack/core/package.json').version;
if (version !== '2.2.8') throw new Error(`Unexpected version ${version}`);
const root = path.resolve(process.env.FIXTURE);
const output = path.resolve(process.env.OUTPUT);
const samples = [];
function memory(phase) {
  const item = { phase, atMs: performance.now(), rss: process.memoryUsage().rss };
  if (process.platform === 'linux') {
    const s = fs.readFileSync('/proc/self/status', 'utf8');
    for (const key of ['VmHWM', 'VmRSS', 'RssAnon', 'VmSwap', 'Threads']) {
      const match = s.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      item[key] = Number(match[1]) * (key === 'Threads' ? 1 : 1024);
    }
  }
  samples.push(item);
  return item;
}
const makeStarts = {}, makes = {};
function config(name, target) {
  return {
    name, context: root, mode: 'development', target, devtool: 'cheap-module-source-map',
    cache: false, entry: `./${name}.js`, output: { path: path.join(output, name), filename: 'bundle.js', clean: true },
    optimization: { minimize: false }, stats: { all: false, timings: true },
    plugins: [{ apply(compiler) {
      compiler.hooks.make.tap('Measure', () => { makeStarts[name] = performance.now(); });
      compiler.hooks.finishMake.tap('Measure', () => { makes[name] = performance.now() - makeStarts[name]; });
    } }]
  };
}
const compiler = rspack(process.env.VARIANT === 'multi' ? [config('client', 'web'), config('server', 'node')] : config('client', 'web'));
console.log(JSON.stringify({ ready: true, pid: process.pid, version, env: process.env.RSPACK_BLOCKING_THREADS ?? null }));
await new Promise(resolve => { process.stdin.once('data', resolve); process.stdin.resume(); });
process.stdin.pause();
const interval = setInterval(() => memory('sample'), 100);
const before = memory('before');
const cpu = process.cpuUsage();
const start = performance.now();
const stats = await new Promise((resolve, reject) => compiler.run((err, stats) => err ? reject(err) : resolve(stats)));
const wallMs = performance.now() - start;
const cpuBuild = process.cpuUsage(cpu);
const end0 = memory('end0');
if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
const endDeadline = end0.atMs + 12000;
while (performance.now() < endDeadline) {
  await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.ceil(endDeadline - performance.now()))));
}
const end12 = memory('end12');
clearInterval(interval);
const data = stats.toJson({ all: false, timings: true, errors: true });
await new Promise((resolve, reject) => compiler.close(err => err ? reject(err) : resolve()));
fs.writeFileSync(process.env.DRIVER_RESULT, JSON.stringify({ version, env: process.env.RSPACK_BLOCKING_THREADS ?? null, wallMs, cpuUserMs: cpuBuild.user / 1000, cpuSysMs: cpuBuild.system / 1000, cpuMs: (cpuBuild.user + cpuBuild.system) / 1000, makes, statsTimes: data.children ? data.children.map(c => c.time) : [data.time], before, end0, end12, samples }, null, 2));
