import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { rspack } = require(process.env.RSPACK_CORE);
const phase = process.argv[2];
const root = process.env.FIXTURE;
const counts = { build: 0, valid: 0 };
const events = [];
const memory = () => {
  const text = fs.readFileSync('/proc/self/status', 'utf8');
  const read = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]);
  return { rssEndKiB: read('VmRSS'), anonEndKiB: read('RssAnon'), hwmKiB: read('VmHWM'), swapKiB: read('VmSwap') };
};
const compiler = rspack({
  mode: 'development', context: root, entry: './src/index.js', devtool: false,
  output: { path: path.join(path.dirname(root), 'output'), filename: 'main.js' },
  cache: { type: 'persistent', storage: { type: 'filesystem', directory: process.env.CACHE_DIR }, buildDependencies: [path.join(root, 'src/index.js')] },
  experiments: { newCache: false }, incremental: false,
  optimization: { minimize: false }, stats: 'none',
});
compiler.hooks.thisCompilation.tap('measure', compilation => {
  compilation.hooks.buildModule.tap('measure', () => counts.build++);
  compilation.hooks.stillValidModule.tap('measure', () => counts.valid++);
});
compiler.hooks.infrastructureLog.tap('measure', (origin, type, args) => { events.push({ origin, type, args }); });
const now = () => performance.now();
const close = () => new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
console.log('READY');
await new Promise(resolve => process.stdin.once('data', resolve));
const started = now();
try {
  const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)));
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
  const buildMs = now() - started;
  const buildEndUnixMs = Date.now();
  const mem = memory();
  const graph = stats.compilation.modules.size;
  if (phase === 'warm' && (counts.build !== 0 || counts.valid !== graph)) throw new Error(`not a warm hit: ${JSON.stringify({ counts, graph })}`);
  const logs = stats.toJson({ all: false, logging: 'verbose', loggingDebug: [/./] }).logging;
  const hasher = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(path.join(path.dirname(root), 'output/main.js'))) hasher.update(chunk);
  const hash = hasher.digest('hex');
  const flatten = entries => entries.flatMap(e => [e, ...flatten(e.children || [])]);
  const makeEntries = Object.values(logs || {}).flatMap(log => flatten(log.entries || [])).filter(e => e.type === 'time' && String(e.message).startsWith('read make from persistent cache:'));
  const makeMatch = makeEntries[0]?.message.match(/: ([\d.]+) ms/);
  const makeRestoreMs = makeMatch ? Number(makeMatch[1]) : null;
  if (phase === 'warm' && !Number.isFinite(makeRestoreMs)) throw new Error('missing make restore logger timing');
  const checkpoint = { phase, buildMs, buildEndUnixMs, makeRestoreMs, ...mem, graph, counts, hash, logs, events };
  console.log('CHECKPOINT ' + JSON.stringify(checkpoint));
  // Teardown and cache flush are deliberately outside the warm-start timer.
  await close();
  console.log('RESULT ' + JSON.stringify(checkpoint));
} catch (error) { await close().catch(() => {}); throw error; }
