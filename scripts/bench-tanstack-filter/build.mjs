import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const condition = process.env.BENCH_CONDITION;
const diagnostic = process.env.BENCH_DIAGNOSTIC === '1';
const records = { rule: [], transform: [] };
const root = process.cwd();
const cleanId = id => id.split(root).join('<app>').split(encodeURIComponent(root)).join('%3Capp%3E');
if (diagnostic) globalThis.__referenceProbe = (name, id, accepted, stage) => {
  if (name === 'tanstack-router:code-splitter:compile-reference-file') records[stage].push({ id: cleanId(id), accepted });
};
const { rspack } = await import('@rspack/core');
const routerPlugin = await import('@tanstack/router-plugin/rspack');
const tanstackRouter = routerPlugin.tanstackRouter ?? routerPlugin.TanStackRouterRspack;
if (!tanstackRouter) throw new Error(`No router plugin export: ${Object.keys(routerPlugin)}`);
let phase = condition === 'warm' ? 'baseline' : 'cold';
let began = performance.now();
let cpu = process.cpuUsage();
let makeBegan;
let makeMs;
let compiler;
const phaseHooks = { apply(c) {
  c.hooks.watchRun.tap('Benchmark', () => { began = performance.now(); cpu = process.cpuUsage(); });
  c.hooks.make.tap({ name: 'Benchmark', stage: -1000000 }, () => { makeBegan = performance.now(); });
  c.hooks.finishMake.tap({ name: 'Benchmark', stage: 1000000 }, () => { makeMs = performance.now() - makeBegan; });
} };
function manifest(dir) {
  const result = {};
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) walk(filename);
      else result[path.relative(dir, filename)] = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    }
  }
  walk(dir);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
compiler = rspack({
  mode: 'production', context: root, entry: './src/main.tsx', devtool: false,
  cache: condition === 'warm',
  output: { path: out, filename: 'main.js', chunkFilename: '[id].js', clean: true },
  resolve: { extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'] },
  module: { rules: [{ test: /\.[jt]sx?$/, exclude: /node_modules/, use: [{ loader: 'builtin:swc-loader', options: {
    jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2020' },
  } }] }] },
  optimization: { minimize: false, moduleIds: 'deterministic', chunkIds: 'deterministic', concatenateModules: false, usedExports: false, sideEffects: false },
  plugins: [phaseHooks, tanstackRouter({ target: 'react', autoCodeSplitting: true,
    routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' })],
  stats: 'errors-warnings',
});
function send(message) { return new Promise(resolve => { process.once('message', resolve); process.send(message); }); }
async function done(error, stats) {
  try {
    if (error) throw error;
    if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true, errorDetails: true }));
    const wallMs = performance.now() - began;
    const elapsedCpu = process.cpuUsage(cpu);
    if (phase === 'baseline') {
      phase = 'warm';
      began = performance.now(); cpu = process.cpuUsage();
      await send({ type: 'start', phase });
      fs.writeFileSync(path.join(root, 'src/data/m00000.ts'), 'export const value = 1;\n');
      return;
    }
    await send({ type: 'end', phase, wallMs, cpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000, makeMs });
    const emitted = manifest(out);
    let semantic;
    if (diagnostic) {
      const cases = ['/src/routes/r000.tsx', '/src/routes/r000.tsx?tsr-split=component', '/src/routes/r000.tsx?tsr-shared',
        '/src/tsr-split/normal.tsx', '/src/tsr-shared/normal.tsx', '/tsr-split', '/tsr-shared', '/src/a.tsx?tsr-split=x.tsx'];
      const filters = {
        S: { exclude: ['tsr-split', 'tsr-shared'], include: /\.(m|c)?(j|t)sx?$/ },
        R: { exclude: [/[?&]tsr-split(?:[=&]|$)/, /[?&]tsr-shared(?:[=&]|$)/], include: /\.(m|c)?(j|t)sx?$/ },
        N: { include: /\.(m|c)?(j|t)sx?$/ },
      };
      semantic = cases.map(suffix => {
        const id = root + suffix;
        return { id: cleanId(id), ...Object.fromEntries(Object.entries(filters).map(([arm, filter]) => [arm, globalThis.__idFilterFactory(filter)(id)])) };
      });
    }
    fs.writeFileSync(process.env.BENCH_RESULT, JSON.stringify({ emitted, records: diagnostic ? records : undefined, semantic }, null, 2));
    if (watcher) await new Promise((resolve, reject) => watcher.close(e => e ? reject(e) : resolve()));
    else await new Promise((resolve, reject) => compiler.close(e => e ? reject(e) : resolve()));
    process.disconnect();
  } catch (error) { console.error(error); process.exitCode = 1; process.disconnect(); }
}
let watcher;
if (condition === 'cold') {
  await send({ type: 'start', phase });
  began = performance.now(); cpu = process.cpuUsage();
  compiler.run(done);
} else watcher = compiler.watch({ aggregateTimeout: 20 }, done);
