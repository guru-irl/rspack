import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const [phase, output] = process.argv.slice(2);
const root = path.resolve(process.env.PROJECT);
const { rspack } = await import(
  pathToFileURL(path.resolve(process.env.RSPACK_CORE)).href
);
const native = process.platform === 'darwin' ? require('./memory.node') : null;
const start = performance.now();
const cpuStart = process.cpuUsage();
const events = [],
  anchors = [];
let ack;
const input = readline.createInterface({ input: process.stdin });
input.on('line', () => {
  if (ack) {
    const r = ack;
    ack = null;
    r();
  }
});
let done,
  idleDone = false,
  complete = false;
let resolveIdle;
let idle;
function resetIdle() {
  idleDone = false;
  idle = new Promise((r) => {
    resolveIdle = r;
  });
}
resetIdle();
let editStart, editCpu;
const rounds = [];
const outputsByRound = [];
const postDoneMs = JSON.parse(process.env.POST_DONE_MS || '[100, 500]');
const idleTimeoutMs = Number(process.env.IDLE_TIMEOUT_MS || 3000);
if (
  !Array.isArray(postDoneMs) ||
  postDoneMs.some(
    (v, i) =>
      !Number.isFinite(v) ||
      v <= 0 ||
      v >= idleTimeoutMs ||
      (i && v <= postDoneMs[i - 1]),
  )
)
  throw new Error('Invalid post-done offsets');
const deadline = setTimeout(() => {
  console.error('Harness deadline exceeded');
  process.exit(2);
}, 240000);
process.on('exit', () => {
  if (!complete) process.exitCode = 2;
});
const checkpoint = () => {
  const cpu = process.cpuUsage(cpuStart);
  return {
    wall_ms: performance.now() - start,
    cpu_ms: (cpu.user + cpu.system) / 1000,
  };
};
function memory() {
  if (native) return native.sample();
  if (process.platform === 'win32') return {}; // Parent samples exact kernel counters at the marker.
  return Object.fromEntries(
    fs
      .readFileSync('/proc/self/status', 'utf8')
      .split('\n')
      .map((l) => l.match(/^(VmHWM|VmRSS|RssAnon|RssFile):\s+(\d+) kB/))
      .filter(Boolean)
      .map((m) => [m[1], Number(m[2]) * 1024]),
  );
}
async function anchor(name, gc = false) {
  if (gc) {
    if (!global.gc) throw new Error('--expose-gc required');
    global.gc();
  }
  const value = {
    name,
    ...checkpoint(),
    memory: memory(),
    idle_complete: idleDone,
  };
  if (name === 'rebuild_done') {
    const cpu = process.cpuUsage(editCpu);
    value.rebuild_ms = start + value.wall_ms - editStart;
    value.rebuild_cpu_ms = (cpu.user + cpu.system) / 1000;
  }
  anchors.push(value);
  console.log(JSON.stringify({ marker: name, ...value }));
  if (process.env.PARENT_SAMPLER === '1')
    await new Promise((resolve) => {
      ack = resolve;
    });
  return value;
}
function manifest() {
  const rows = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else {
        const data = fs.readFileSync(file);
        rows.push({
          name: path
            .relative(path.join(root, 'dist'), file)
            .split(path.sep)
            .join('/'),
          bytes: data.length,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
        });
      }
    }
  }
  walk(path.join(root, 'dist'));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
const config = {
  name: 'sanity',
  mode: 'development',
  context: root,
  entry: './src/index.js',
  devtool: false,
  output: { path: path.join(root, 'dist'), clean: false },
  module: {
    rules: [
      { test: /\.css$/, type: 'css/auto' },
      {
        test: /\.js$/,
        include: path.join(root, 'src'),
        use: [path.join(root, 'loaders/tag-loader.cjs')],
      },
    ],
  },
  cache: {
    type: 'filesystem',
    cacheLocation: path.join(root, 'cache'),
    version: 'synthetic-sanity',
    idleTimeout: idleTimeoutMs,
    idleTimeoutForInitialStore: idleTimeoutMs,
    idleTimeoutAfterLargeChanges: idleTimeoutMs,
    buildDependencies: { harness: [import.meta.filename] },
  },
  experiments: { newCache: true },
  infrastructureLogging: { level: 'log', debug: /rspack\./ },
  stats: 'none',
  plugins: [
    {
      apply(c) {
        c.hooks.infrastructureLog.tap('sanity', (origin, type, args) => {
          const text = String(args);
          if (text.includes('Benchmark idle cache interrupted'))
            throw new Error('Idle interrupted');
          events.push({ origin, type, text, ...checkpoint() });
          if (text.includes('Benchmark idle cache complete')) {
            idleDone = true;
            resolveIdle();
          }
          return true;
        });
        c.hooks.done.tapPromise('sanity', async (stats) => {
          if (stats.hasErrors())
            throw new Error(stats.toString({ all: false, errors: true }));
          done = await anchor(
            editStart === undefined ? 'done' : 'rebuild_done',
          );
          rounds.push(done);
        });
      },
    },
  ],
};
const compiler = rspack(config);
async function waitIdle() {
  await Promise.race([
    idle,
    delay(180000, undefined, { ref: false }).then(() => {
      throw new Error('Missing idle completion');
    }),
  ]);
  await delay(2000);
}
async function postDone() {
  const doneAt = start + done.wall_ms;
  for (const offset of postDoneMs) {
    await delay(Math.max(0, doneAt + offset - performance.now()));
    const a = await anchor(`post_done_${offset}ms`);
    a.actual_after_done_ms = a.wall_ms - done.wall_ms;
    if (a.idle_complete || a.actual_after_done_ms >= idleTimeoutMs)
      throw new Error('Pre-timeout checkpoint ran too late');
  }
}
let watching;
let resolveRound, rejectRound;
let pending;
const nextRound = () => {
  pending = new Promise((res, rej) => {
    resolveRound = res;
    rejectRound = rej;
  });
};
if (phase === 'watch') {
  nextRound();
  watching = compiler.watch({ aggregateTimeout: 50 }, (e, stats) =>
    e ? rejectRound(e) : resolveRound(stats),
  );
  await pending;
} else {
  await new Promise((res, rej) => compiler.run((e) => (e ? rej(e) : res())));
}
if (phase === 'warm') await postDone();
outputsByRound.push(manifest());
await waitIdle();
await anchor('END', true);
if (watching) {
  const leaf = path.join(root, 'src/d0/m9.js');
  const original = fs.readFileSync(leaf, 'utf8');
  resetIdle();
  nextRound();
  editStart = performance.now();
  editCpu = process.cpuUsage();
  console.log(JSON.stringify({ marker_event: 'edit_start', ...checkpoint() }));
  fs.writeFileSync(leaf, original + '\n// public synthetic edit\n');
  await pending;
  outputsByRound.push(manifest());
  await waitIdle();
  await anchor('rebuild_END', true);
}
const closeStart = performance.now();
if (watching)
  await new Promise((res, rej) => watching.close((e) => (e ? rej(e) : res())));
await new Promise((res, rej) => compiler.close((e) => (e ? rej(e) : res())));
const closeMs = performance.now() - closeStart;
await anchor('post_close', true);
if (!done || !idleDone) throw new Error('Missing anchor');
if (
  events.some((e) =>
    /Failed to .*cache|cache.*unavailable|Resetting cache/i.test(e.text),
  )
)
  throw new Error('Cache failure');
const result = {
  phase,
  source: process.env.SOURCE_SHA,
  pid: process.pid,
  anchors,
  events,
  outputs: manifest(),
  outputs_by_round: outputsByRound,
  close_ms: closeMs,
  rebuild_ms: rounds[1]?.rebuild_ms,
  checkpoints_ms: postDoneMs,
  idle_timeout_ms: idleTimeoutMs,
  node: process.version,
  platform: process.platform,
};
fs.writeFileSync(output, JSON.stringify(result));
complete = true;
clearTimeout(deadline);
input.close();
console.log(JSON.stringify({ marker: 'complete' }));
