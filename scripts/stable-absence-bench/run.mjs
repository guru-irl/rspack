import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [rootArg, coreArg, outArg, variant = 'barrel'] = process.argv.slice(2);
const root = path.resolve(rootArg);
const out = path.resolve(outArg);
const { rspack } = await import(pathToFileURL(path.resolve(coreArg, 'dist/index.js')).href);
const realpath = fs.realpathSync.native;
const binding = realpath(process.env.RSPACK_BINDING);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bindingSha256 = sha(binding);
assert.equal(bindingSha256, process.env.EXPECTED_BINDING_SHA256);
let loaded;
if (process.platform === 'linux') {
  loaded = [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n').map(line => line.trim().split(/\s+/).slice(5).join(' ')).filter(file => file.endsWith('.node')))];
} else {
  loaded = process.report.getReport().sharedObjects.filter(file => file.endsWith('.node'));
}
assert(loaded.map(file => realpath(file)).includes(binding), 'Expected binding was not loaded');
assert(loaded.every(file => sha(realpath(file)) === bindingSha256), 'Unexpected native binding');
assert.equal(typeof global.gc, 'function', 'Use --expose-gc');
const leaf = path.join(root, variant === 'barrel' ? 'barrel/constants.js' : 'src/g0/m0.js');
const original = fs.readFileSync(leaf);
const edited = variant === 'barrel' ? Buffer.from('export const value = "edited";\n') : Buffer.from(original.toString().replace('const seed = 0;', 'const seed = 999999;'));
assert(!original.equals(edited));
const report = {
  variant, bindingSha256, loaded,
  host: { platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model, node: process.version },
  records: [],
};
let emittedFiles = 0;
const compiler = rspack({
  context: root, mode: 'development', target: 'node', entry: './entry.js',
  devtool: false, cache: false, incremental: true,
  output: { path: path.join(root, 'out'), filename: 'bundle.cjs', chunkFilename: '[name].cjs', clean: true },
  module: { rules: [{ test: /\.ts$/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript' } } } } }] },
  optimization: {
    minimize: false, concatenateModules: false, usedExports: false, sideEffects: 'flag',
    moduleIds: 'named', chunkIds: 'named', splitChunks: { chunks: 'all' },
  },
  plugins: [{ apply(c) {
    c.hooks.thisCompilation.tap('MeasureEmission', () => { emittedFiles = 0; });
    c.hooks.assetEmitted.tap('MeasureEmission', () => { emittedFiles++; });
  } }],
});
function baseline() { return { wall: performance.now(), cpu: process.cpuUsage() }; }
function timer(entries, name, required = true) {
  const values = entries.filter(e => e.type === 'time' && e.message.startsWith(name + ': '));
  if (!required && values.length === 0) return 0;
  assert.equal(values.length, 1, 'Missing or duplicate timer ' + name + ': ' + JSON.stringify(entries));
  const match = values[0].message.match(/: ([\d.]+) ms$/);
  assert(match, 'Invalid timer ' + values[0].message);
  return Number(match[1]);
}
async function memory(record, phase) {
  global.gc(); global.gc();
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  if (!process.env.MEASURE_MEMORY) return;
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/footprint', ['--noCategories', '-f', 'bytes', '-p', String(process.pid)], { encoding: 'utf8', timeout: 30000 });
    const text = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(out + '.' + phase + '.footprint.txt', text);
    assert.equal(result.status, 0, text);
    const current = text.match(/phys_footprint:\s*([\d,]+) B/);
    const peak = text.match(/phys_footprint_peak:\s*([\d,]+) B/);
    assert(current && peak, 'Cannot parse physical footprint');
    record.steadyBytes = Number(current[1].replaceAll(',', ''));
    record.peakBytes = Number(peak[1].replaceAll(',', ''));
  } else {
    fs.writeFileSync(out + '.memory-request', phase);
    const response = out + '.memory-response';
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(response)) {
      assert(Date.now() < deadline, 'Memory checkpoint timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    Object.assign(record, JSON.parse(fs.readFileSync(response, 'utf8')));
    fs.unlinkSync(response);
  }
}
let waiter, watching, start = baseline(), phase = 'cold', extraBuilds = 0;
function nextBuild() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Build timed out: ' + phase)), 600000);
    waiter = {
      resolve: stats => { clearTimeout(timeout); resolve(stats); },
      reject: error => { clearTimeout(timeout); reject(error); },
    };
  });
}
async function capture(stats) {
  const wallMs = performance.now() - start.wall;
  const cpu = process.cpuUsage(start.cpu);
  assert(!stats.hasErrors(), stats.toString({ all: false, errors: true }));
  const logging = stats.toJson({ all: false, logging: 'verbose' }).logging;
  const entries = name => logging?.[name]?.entries || [];
  const graph = entries('rspack.Compilation');
  const cacheLog = entries('rspack.Compilation.codeSplittingCache').map(e => e.message);
  const topologyChanged = cacheLog.some(line => line.includes('module topology change detected'));
  const record = {
    phase, wallMs, cpuMs: (cpu.user + cpu.system) / 1000,
    statsHash: stats.hash, hasCompilationHashLiteral: false,
    emitMs: timer(entries('rspack.Compiler'), 'emitAssets'), emittedFiles,
    buildGraphMs: timer(graph, 'build chunk graph'),
    rebuildGraphMs: timer(graph, 'rebuild chunk graph', false),
    splitChunksMs: timer(entries('rspack.SplitChunksPlugin'), 'process cache groups', false),
    topologyChanged, cacheLog, modules: stats.compilation.modules.size, chunks: stats.compilation.chunks.size,
  };
  assert.equal(typeof record.statsHash, 'string');
  assert(record.statsHash.length > 0);
  record.assets = Object.fromEntries(stats.compilation.getAssets().map(({ name, source }) => {
    const bytes = source.buffer();
    if (bytes.includes(Buffer.from(record.statsHash))) record.hasCompilationHashLiteral = true;
    assert(fs.readFileSync(path.join(root, 'out', name)).equals(bytes), 'Emitted bytes differ from compilation');
    return [name, { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  }).sort(([a], [b]) => a.localeCompare(b)));
  record.membership = Object.fromEntries([...stats.compilation.chunks].map(chunk => [String(chunk.id), crypto.createHash('sha256').update([...stats.compilation.chunkGraph.getChunkModulesIterable(chunk)].map(m => m.identifier()).sort().join('\n')).digest('hex')]).sort(([a], [b]) => a.localeCompare(b)));
  await memory(record, phase);
  report.records.push(record);
  console.log(JSON.stringify(record));
}
try {
  const first = nextBuild();
  watching = compiler.watch({ aggregateTimeout: 0 }, (error, stats) => {
    const pending = waiter;
    waiter = undefined;
    if (!pending) { extraBuilds++; return; }
    if (error) pending.reject(error);
    else if (!stats) pending.reject(new Error('No stats'));
    else pending.resolve(stats);
  });
  await capture(await first);
  for (const [name, content] of [['rebuild', edited], ['revert', original]]) {
    phase = name;
    const next = nextBuild();
    start = baseline();
    fs.writeFileSync(leaf, content);
    await capture(await next);
  }
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  if (watching) await new Promise((resolve, reject) => watching.close(error => error ? reject(error) : resolve()));
  fs.writeFileSync(leaf, original);
  await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
  report.extraBuilds = extraBuilds;
  if (extraBuilds) { report.error = 'Unexpected overlapping build'; process.exitCode = 1; }
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
