// Run a cold watch build and two real file edits from a common working path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { rspack } = require('@rspack/core');
const root = path.resolve(process.argv[2] || 'fixture');
const out = path.join(root, 'dist');
const hashBuffer = Buffer.allocUnsafe(64 * 1024);
const sha = p => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    for (let n; (n = fs.readSync(fd, hashBuffer, 0, hashBuffer.length, null)) > 0;) hash.update(hashBuffer.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
const loaded = [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n')
  .map(line => line.trim().split(/\s+/).slice(5).join(' '))
  .filter(p => p.endsWith('.node') && p.includes('rspack')))];
if (loaded.length !== 1) throw Error(`expected one rspack binding, got ${JSON.stringify(loaded)}`);
const loadedSha = sha(loaded[0]);
if (process.env.EXPECT_SHA && process.env.EXPECT_SHA !== loadedSha) throw Error('binding SHA mismatch');
const compiler = rspack({
  context: root,
  mode: 'development',
  devtool: false,
  entry: './src/index.js',
  output: { path: out, clean: true },
  cache: false,
  incremental: true,
  optimization: { sideEffects: true },
  module: { rules: [{ test: /\.css$/, type: 'css/auto' }] },
  infrastructureLogging: { level: 'error' },
  performance: false,
});
let started = process.hrtime.bigint();
let phase = 0;
let windowPeakRss = process.memoryUsage().rss;
const sampler = setInterval(() => { windowPeakRss = Math.max(windowPeakRss, process.memoryUsage().rss); }, 20);
sampler.unref();
const kill = setTimeout(() => { console.error('watch timed out'); process.exit(3); }, 20 * 60 * 1000);
const watching = compiler.watch({ aggregateTimeout: 50 }, (err, stats) => {
  if (err || !stats || stats.hasErrors() || stats.hasWarnings()) {
    console.error(err || stats.toString('errors-warnings'));
    watching.close(() => process.exit(2));
    return;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const rss = process.memoryUsage().rss;
  const peakRss = process.resourceUsage().maxRSS * 1024;
  windowPeakRss = Math.max(windowPeakRss, rss);
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const outputs = walk(out).map(p => [path.relative(out, p), sha(p)]).sort((a, b) => a[0].localeCompare(b[0]));
  const modules = process.env.COUNT_MODULES && phase === 2 ? stats.compilation.modules.size : null;
  if (modules !== null) {
    if (modules < 30000) throw Error(`fixture built only ${modules} modules`);
    if (!outputs.some(([name]) => name.endsWith('.css'))) throw Error('fixture emitted no CSS');
    if (outputs.filter(([name]) => name.endsWith('.js')).length < 2) throw Error('fixture emitted no async JavaScript');
    const main = fs.readFileSync(path.join(out, 'main.js'), 'utf8');
    if (!main.includes('effect100')) throw Error('fixture omitted side-effect imports');
    if (!main.includes('m200.cjs')) throw Error('fixture omitted CommonJS requires');
  }
  console.log(JSON.stringify({ phase, elapsedMs, rss, peakRss, windowPeakRss, modules, binding: loadedSha, outputs }));
  if (phase === 2) {
    clearInterval(sampler);
    watching.close(err => compiler.close(closeErr => {
      clearTimeout(kill);
      if (err || closeErr) { console.error(err || closeErr); process.exitCode = 4; }
    }));
    return;
  }
  const i = phase++;
  setTimeout(() => {
    windowPeakRss = process.memoryUsage().rss;
    started = process.hrtime.bigint();
    fs.writeFileSync(path.join(root, 'src', 'modules', `m${i}.js`), `export const v${i} = ${i + 1000000};\n`);
  }, 100);
});
