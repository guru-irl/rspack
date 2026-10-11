'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const pkgRoot = path.resolve(process.argv[2]);
const fixture = path.resolve(process.argv[3]);
const eventFile = path.resolve(process.argv[4]);
const output = path.resolve(process.argv[5]);
const req = createRequire(path.join(pkgRoot, 'package.json'));
function event(kind, extra = {}) {
  fs.appendFileSync(eventFile, JSON.stringify({ kind, wall_ns: String(BigInt(Date.now()) * 1000000n), memory: process.memoryUsage(), ...extra }) + '\n');
}
event('process_ready', { pid: process.pid, node: process.version });
const { rspack } = req('@rspack/core');
const version = req('@rspack/core/package.json').version;
event('binding_loaded', { version });
const compiler = rspack(['client', 'server'].map(name => ({
  name,
  context: fixture,
  target: name === 'client' ? 'web' : 'node',
  mode: 'development',
  devtool: 'cheap-module-source-map',
  entry: `./${name}.js`,
  output: { path: path.join(output, name), filename: 'bundle.js', ...(name === 'server' ? { library: { type: 'commonjs2' } } : {}) },
  cache: true,
  optimization: { minimize: false },
  plugins: [{ apply(child) {
    child.hooks.beforeCompile.tap('SyntheticLifecycle', () => event('before_compile', { compiler: name }));
    child.hooks.afterCompile.tap('SyntheticLifecycle', () => event('after_compile', { compiler: name }));
    child.hooks.done.tap('SyntheticLifecycle', stats => event('compiler_done', { compiler: name, errors: stats.hasErrors(), startTime: stats.startTime, endTime: stats.endTime }));
  } }],
  stats: 'errors-only'
})));
globalThis.syntheticCompiler = compiler; // retain a dev-server-like compiler and its compilation
let buildStats;
event('run_start');
compiler.run((error, stats) => {
  if (error || !stats || stats.hasErrors()) {
    event('build_failed', { error: String(error || stats.toString('errors-only')) });
    process.exitCode = 1;
    compiler.close(() => { process.exit(1); });
    return;
  }
  buildStats = stats; // retain the same stats throughout idle, no forced V8 GC
  event('build_done');
  for (const seconds of [1, 5, 10, 15, 30, 60]) {
    setTimeout(() => event('idle_mark', { seconds }), seconds * 1000);
  }
  setTimeout(() => {
    event('close_start', { retainedStats: Boolean(buildStats) });
    compiler.close(closeError => {
      event('close_done', { error: closeError ? String(closeError) : null });
      process.exit(closeError ? 1 : 0);
    });
  }, 60200);
});
