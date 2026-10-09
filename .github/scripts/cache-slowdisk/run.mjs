import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { rspack } = require(process.env.RSPACK_CORE);
const phase = process.argv[2];
if (!['seed', 'warm'].includes(phase)) throw new Error('usage: run.mjs seed|warm');
const project = process.env.FIXTURE;
const cacheDir = process.env.CACHE_DIR;
const expected = Number(process.env.MODULES) * 1.2 + 61;
let sawStored = false;
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (String(chunk).includes('Stored cache')) sawStored = true;
  return write(chunk, ...rest);
};

const config = {
  mode: 'development',
  context: project,
  entry: './src/index.js',
  devtool: false,
  output: { path: path.join(path.dirname(project), 'output'), clean: false },
  module: {
    rules: [
      { test: /\.css$/, type: 'css/auto' },
      { test: /\.js$/, include: path.join(project, 'src'), use: [path.join(project, 'loaders/tag-loader.cjs')] },
    ],
  },
  cache: {
    type: 'persistent',
    storage: { type: 'filesystem', directory: cacheDir },
    buildDependencies: [fileURLToPath(import.meta.url)],
  },
  experiments: { newCache: true },
  infrastructureLogging: { level: 'log', debug: /rspack\./ },
  stats: 'none',
};
const counts = { buildModule: 0, stillValidModule: 0 };
const times = {};
const now = () => performance.now();
const t0 = now();
const compiler = rspack(config);
compiler.hooks.thisCompilation.tap('measure', compilation => {
  compilation.hooks.buildModule.tap('measure', () => counts.buildModule++);
  compilation.hooks.stillValidModule.tap('measure', () => counts.stillValidModule++);
  compilation.hooks.finishModules.tap('measure', () => { times.finish = now(); });
});
compiler.hooks.make.tap('measure', () => { times.make = now(); });
compiler.hooks.done.tap('measure', () => { times.done = now(); });
const close = () => new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
try {
  const stats = await new Promise((resolve, reject) => compiler.run((error, value) => error ? reject(error) : resolve(value)));
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
  const graph = stats.compilation.modules.size;
  if (graph !== expected) throw new Error(`graph ${graph}, expected ${expected}`);
  if (phase === 'warm' && (counts.stillValidModule !== graph || counts.buildModule !== 0)) {
    throw new Error(`invalid warm hit: ${JSON.stringify(counts)}, graph ${graph}`);
  }
  const mem = fs.readFileSync('/proc/self/status', 'utf8');
  const kib = field => Number(mem.match(new RegExp(`^${field}:\\s+(\\d+)`, 'm'))?.[1] ?? NaN);
  const checkpoint = {
    buildMs: times.done - t0,
    makeMs: times.finish - times.make,
    modules: graph,
    counts,
    rssAnonEndKiB: kib('RssAnon'),
    vmHwmKiB: kib('VmHWM'),
  };
  if (!Number.isFinite(checkpoint.makeMs)) throw new Error('missing make timer');
  console.log(`CHECKPOINT ${JSON.stringify(checkpoint)}`);
  if (phase === 'seed') {
    const deadline = Date.now() + 120000;
    while (!sawStored && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    if (!sawStored) throw new Error('seed did not report Stored cache');
  }
  await close();
  console.log(`RESULT ${JSON.stringify({ ...checkpoint, phase, sawStored })}`);
} catch (error) {
  await close().catch(() => {});
  throw error;
}
