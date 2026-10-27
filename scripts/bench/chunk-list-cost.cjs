const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const root = process.env.COST_ROOT;
assert(root && process.env.EXPECTED_NATIVE_SHA256);
const { rspack } = require(path.resolve('packages/rspack/dist'));
const mapped = [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n')
  .map(line => line.match(/\s(\/.*\.node)$/)?.[1]).filter(file => file?.includes('rspack')))];
assert.equal(mapped.length, 1, JSON.stringify(mapped));
const nativeSha256 = crypto.createHash('sha256').update(fs.readFileSync(mapped[0])).digest('hex');
assert.equal(nativeSha256, process.env.EXPECTED_NATIVE_SHA256, 'Wrong mapped native binding');
if (process.argv[2] === 'identity') {
  console.log(JSON.stringify({ nativeSha256, mapped: mapped[0] }));
  process.exit(0);
}
const kind = process.argv[2];
assert(['steady', 'crossing'].includes(kind));
const context = path.join(root, 'fixture');
fs.mkdirSync(context, { recursive: true });
const count = 5000;
const imports = [];
for (let i = 0; i < count; i++) {
  fs.writeFileSync(path.join(context, `leaf-${i}.js`), 'export default "leaf-a";\n');
  imports.push(`() => import(/* webpackChunkName: "batch-${Math.floor(i / 10)}" */ "./leaf-${i}.js")`);
}
fs.writeFileSync(path.join(context, 'index.js'), `export const load = [${imports.join(',\n')}];\nexport const pair = () => Promise.all([import("./a.js"), import("./b.js")]);\n`);
for (const name of ['a', 'b']) {
  fs.writeFileSync(path.join(context, `${name}.js`), `import shared from "./shared"; export default shared + "${name}";\n`);
}
const long = `export default ${JSON.stringify('first'.repeat(30))};\n`;
fs.writeFileSync(path.join(context, 'shared.js'), long);
const compiler = rspack({
  context, mode: 'development', target: 'node', devtool: false,
  entry: './index.js',
  output: { path: path.join(context, 'dist'), filename: 'main.js', chunkFilename: '[name].[contenthash].js', library: { type: 'commonjs2' } },
  optimization: { minimize: false, usedExports: false, concatenateModules: false, moduleIds: 'named', chunkIds: 'named',
    splitChunks: { chunks: 'all', minSize: 0, cacheGroups: { default: false, defaultVendors: false,
      shared: { test: /shared\.js$/, name: 'selected', minChunks: 2, minSize: 80 } } } },
  infrastructureLogging: { level: 'none' }
});
function run(file) {
  return new Promise((resolve, reject) => {
    const before = process.resourceUsage();
    const begin = performance.now();
    compiler.run((error, stats) => {
      const milliseconds = performance.now() - begin;
      const after = process.resourceUsage();
      const cpuMilliseconds = (after.userCPUTime - before.userCPUTime + after.systemCPUTime - before.systemCPUTime) / 1000;
      if (error) return reject(error);
      if (!stats || stats.hasErrors()) return reject(new Error(stats?.toString() || 'Missing stats'));
      resolve({ stats, milliseconds, cpuMilliseconds });
    }, file ? { modifiedFiles: new Set([file]), removedFiles: new Set() } : {});
  });
}
function groups(stats) {
  return [...stats.compilation.chunkGroups].map(group => [group.name, group.chunks.map(chunk => chunk.id)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}
async function main() {
  const first = await run();
  const initialGroups = groups(first.stats);
  assert(initialGroups.length >= 300, `Only ${initialGroups.length} chunk groups`);
  assert([...first.stats.compilation.chunks].some(chunk => chunk.id === 'selected'));
  const samples = [];
  const cpuSamples = [];
  const file = path.join(context, kind === 'steady' ? 'leaf-0.js' : 'shared.js');
  for (let i = 0; i < 16; i++) {
    const short = i % 2 === 0;
    fs.writeFileSync(file, kind === 'steady' ? `export default "leaf-${short ? 'b' : 'a'}";\n` : short ? 'export default "short";\n' : long);
    const { stats, milliseconds, cpuMilliseconds } = await run(file);
    const currentGroups = groups(stats);
    if (kind === 'steady') assert.deepEqual(currentGroups, initialGroups, 'A steady edit changed chunk lists');
    else assert.equal([...stats.compilation.chunks].some(chunk => chunk.id === 'selected'), !short, 'The edit did not cross the split threshold');
    if (i >= 4) { samples.push(milliseconds); cpuSamples.push(cpuMilliseconds); }
  }
  if (global.gc) global.gc();
  const result = { kind, pair: Number(process.env.COST_PAIR), arm: process.env.COST_ARM, nativeSha256, dynamicImports: count + 2, chunkGroups: initialGroups.length,
    samples, cpuSamples, steadyRssKiB: process.memoryUsage().rss / 1024, peakRssKiB: process.resourceUsage().maxRSS };
  await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
  assert.equal(samples.length, 12);
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
