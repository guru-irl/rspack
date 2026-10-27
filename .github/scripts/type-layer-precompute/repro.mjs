import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import rspack from '@rspack-canary/core';
import { verifyNative } from './native.mjs';
let native;
const root = path.resolve('split-chunks-native-repro');
const [variant, mode = 'type', pattern = 'nested', runsArg = '6'] = process.argv.slice(2);
const context = path.join(root, 'selectivity-fixture');
const count = 6000;
const groups = 60;
if (variant === 'setup') {
  await fs.mkdir(context, { recursive: true });
  const imports = [`import changed from './changed.js';`];
  for (let i = 0; i < count; i++) {
    const dir = path.join('node_modules', `pkg-${i % groups}`, 'src', 'components', 'shared', 'common', 'utilities', 'generated');
    await fs.mkdir(path.join(context, dir), { recursive: true });
    const rel = `./${dir}/mod-${i}.js`;
    await fs.writeFile(path.join(context, rel), `export default ${i};`);
    imports.push(`import n${i} from ${JSON.stringify(rel)};`);
  }
  await fs.writeFile(path.join(context, 'index.js'), imports.join('\n') + '\nconsole.log([changed,' + Array.from({length:count},(_,i)=>`n${i}`).join(',') + ']);\n');
  await fs.writeFile(path.join(context, 'changed.js'), 'export default 0;');
  await fs.writeFile(path.join(context, 'sparse.json'), '{"value":1}');
  console.log(`prepared ${count} modules`);
  process.exit(0);
}
native = verifyNative();
const cacheGroups = { default: false, defaultVendors: false };
for (let i = 0; i < groups; i++) {
  let test;
  if (pattern.startsWith('nested')) test = new RegExp(`[\\\\/]node_modules[\\\\/](?:.*[\\\\/])?pkg-${i}[\\\\/]`);
  else if (pattern.startsWith('simple')) test = new RegExp(`[\\\\/]node_modules[\\\\/]pkg-${i}[\\\\/]`);
  else if (pattern === 'string') test = path.join(context, 'node_modules', `pkg-${i}`) + path.sep;
  cacheGroups[`g${i}`] = { test, name: `g${i}`, enforce: true, ...(mode === 'type' ? { type: 'json' } : { layer: 'server' }) };
}
if (pattern.endsWith('-no-precompute')) cacheGroups.barrier = { type: 'webassembly/sync', name: 'barrier', enforce: true };
const measurements = [];
const compiler = rspack({
  mode: 'development', context, target: 'node', devtool: false,
  entry: { main: { import: ['./index.js', './sparse.json'], layer: 'client' } },
  output: { path: path.join(root, 'selectivity-output'), filename: '[name].js' },
  optimization: { minimize: false, concatenateModules: false, splitChunks: { chunks: 'all', minSize: 0, cacheGroups } },
});
let assets;
let previousHash;
try {
  for (let i = 0; i < Number(runsArg) + 2; i++) {
    const edited = path.join(context, 'changed.js');
    await fs.writeFile(edited, `export default ${i};`);
    compiler.inputFileSystem?.purge?.(edited);
    const start = performance.now();
    const cpu = process.cpuUsage();
    const stats = await new Promise((resolve, reject) => compiler.run((err, stats) => err ? reject(err) : resolve(stats), { modifiedFiles: new Set([edited]) }));
    if (stats.hasErrors()) throw new Error(stats.toString({all:false,errors:true}));
    const wallMs = performance.now() - start;
    const usage = process.cpuUsage(cpu);
    const logging = stats.toJson({all:false,logging:'verbose',loggingDebug:true}).logging;
    const splitLogs = Object.fromEntries(Object.entries(logging ?? {}).filter(([key])=>/SplitChunks/.test(key)));
    if (i >= 2) measurements.push({ wallMs, cpuMs: (usage.user + usage.system) / 1000, splitLogs });
    assets = stats.compilation.getAssets().map(a=>[a.name,createHash('sha256').update(a.source.buffer()).digest('hex')]).sort();
    const currentHash = JSON.stringify(assets);
    if (currentHash === previousHash) throw new Error('Edited source did not change emitted assets');
    previousHash = currentHash;
  }
} finally { await new Promise(resolve=>compiler.close(resolve)); }
const memory = { peakRssKiB: process.resourceUsage().maxRSS, steadyRssKiB: process.memoryUsage().rss / 1024 };
verifyNative();
console.log(JSON.stringify({ variant, mode, pattern, count, groups, measurements, assets, native, memory, node: process.version, arch: process.arch }));
