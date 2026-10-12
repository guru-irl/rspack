import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const [phase, output] = process.argv.slice(2);
const seedOnly = process.env.SEED_ONLY === '1';
const isNew = process.env.ARM !== 'L';
const counted = seedOnly || process.env.COUNT === '1';
let graph_counts = null;
let modules = null;
const root = path.resolve(process.env.PROJECT);
const { rspack } = await import(
  pathToFileURL(path.resolve(process.env.RSPACK_CORE)).href
);
const native = process.platform === 'darwin' ? require('./memory.node') : null;
const start = performance.now() - process.uptime()*1000;
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
const idle = new Promise((r) => {
  resolveIdle = r;
});
const deadline = setTimeout(() => {
  console.error('Harness deadline exceeded');
  process.exit(2);
}, 240000);
process.on('exit', () => {
  if (!complete) process.exitCode = 2;
});
const checkpoint = () => {
  if (seedOnly) return {};
  const cpu = process.cpuUsage(cpuStart);
  return {
    wall_ms: performance.now() - start,
    cpu_ms: (cpu.user + cpu.system) / 1000,
  };
};
function memory() {
  if (seedOnly) return {};
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
  const value = { name, ...checkpoint(), memory: memory() };
  anchors.push(value);
  if (!seedOnly) console.log(JSON.stringify({ marker: name, ...value }));
  if (!seedOnly && process.env.PARENT_SAMPLER === '1')
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
  cache: isNew ? {
    type: 'filesystem',
    cacheLocation: path.join(root, 'cache'),
    version: 'synthetic-sanity',
    buildDependencies: { harness: [import.meta.filename] },
  } : { type: 'persistent', storage: { type: 'filesystem', location: path.join(root, 'cache') }, buildDependencies: [import.meta.filename] },
  incremental: false,
  experiments: isNew ? { newCache: true } : {},
  infrastructureLogging: { level: 'log', debug: /rspack\./ },
  stats: 'none',
  plugins: [
    {
      apply(c) {
        c.hooks.infrastructureLog.tap('sanity', (origin, type, args) => {
          const text = String(args);
          if (text.includes('Benchmark idle cache interrupted') && process.env.CLOSE_DIRECT !== '1')
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
          if (counted) {
            modules = stats.compilation.modules.size;
            let dependencies=0, outgoing=0, incoming=0, entries=0;
            const block=b=>{dependencies+=b.dependencies.length;for(const c of b.blocks)block(c);};
            for(const m of stats.compilation.modules){block(m);outgoing+=stats.compilation.moduleGraph.getOutgoingConnections(m).length;incoming+=stats.compilation.moduleGraph.getIncomingConnections(m).length;}
            for(const e of stats.compilation.entries.values())entries+=e.dependencies.length;
            graph_counts={modules,dependencies:dependencies+entries,connections:outgoing+entries,incoming};
          }
          done = await anchor('done');
        });
      },
    },
  ],
};
const compiler = rspack(config);
await new Promise((res, rej) => compiler.run((e) => (e ? rej(e) : res())));
if (isNew && process.env.CLOSE_DIRECT !== "1") await Promise.race([
  idle,
  delay(180000, undefined, { ref: false }).then(() => {
    throw new Error('Missing idle completion');
  }),
]);
// END is verified new-cache idle completion, not a synthetic delay.
await anchor('END', process.env.CLOSE_DIRECT !== '1');
const close_start = checkpoint();
await new Promise((res, rej) => compiler.close((e) => (e ? rej(e) : res())));
const closed = checkpoint();
await anchor('post_close', true);
if (!done || (isNew && !idleDone && process.env.CLOSE_DIRECT !== "1")) throw new Error('Missing anchor');
if (
  events.some((e) =>
    /Failed to .*cache|cache.*unavailable|Resetting cache/i.test(e.text),
  )
)
  throw new Error('Cache failure');
const result = {
  phase,
  close_start,
  closed,
  modules,
  graph_counts,
  source: process.env.SOURCE_SHA,
  pid: process.pid,
  anchors,
  events,
  outputs: manifest(),
  cache_closed: (() => {let bytes=0,allocated_bytes=0,files=0;const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(e.isFile()){const st=fs.statSync(f);bytes+=st.size;allocated_bytes+=(st.blocks||0)*512;files++;}}};walk(path.join(root,'cache'));return {bytes,allocated_bytes,files};})(),
  node: process.version,
  platform: process.platform,
};
fs.writeFileSync(output, JSON.stringify(result));
complete = true;
clearTimeout(deadline);
input.close();
console.log(JSON.stringify({ marker: 'complete' }));
