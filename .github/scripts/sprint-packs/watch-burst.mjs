import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { rspack } from '../runtime/node_modules/@rspack/core/dist/index.js';
const resultPath = path.resolve(process.argv[2]);
const root = path.resolve('bench-data/watch-fixture');
fs.rmSync(root, {recursive: true, force: true});
fs.mkdirSync(path.join(root, 'src'), {recursive: true});
let entry = 'let total = 0;\n';
for (let i = 0; i < 3000; i++) {
  fs.writeFileSync(path.join(root, 'src', `m${i}.js`), `module.exports = ${i};\n`);
  entry += `total += require('./src/m${i}.js');\n`;
}
fs.writeFileSync(path.join(root, 'entry.js'), entry + 'module.exports = total;\n');
const compiler = rspack({
  mode: 'development', context: root, target: 'node', entry: './entry.js', cache: false, devtool: false,
  experiments: {nativeWatcher: true},
  output: {path: path.join(root, 'out'), filename: 'bundle.cjs'},
  optimization: {minimize: false, concatenateModules: false, moduleIds: 'named', chunkIds: 'named'}
});
if (!compiler.options.experiments.nativeWatcher || compiler.watchFileSystem.constructor.name !== 'NativeWatchFileSystem') throw Error('Native watcher not selected');
const done = [], writes = [];
let readyResolve, failure;
const ready = new Promise(resolve => { readyResolve = resolve; });
const timer = setTimeout(() => { console.error('Watch timeout'); process.exit(1); }, 30000);
const watching = compiler.watch({aggregateTimeout: 200}, (error, stats) => {
  if (error || stats.hasErrors()) {
    failure = error || Error(stats.toString({all: false, errors: true}));
    readyResolve();
    return;
  }
  done.push({at: performance.now(), hash: stats.hash});
  if (done.length === 1) readyResolve();
});
await ready;
if (failure) throw failure;
await delay(300);
for (let i = 0; i < 5; i++) {
  if (i) await delay(100);
  writes.push(performance.now());
  fs.writeFileSync(path.join(root, 'src/m0.js'), `module.exports = ${10000 + i};\n`);
}
await delay(1800);
if (failure) throw failure;
await new Promise((resolve, reject) => watching.close(error => error ? reject(error) : resolve()));
await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
clearTimeout(timer);
if (done.length < 2) throw Error('No rebuild observed');
const result = {modules: 3001, nativeWatcher: true, watcher: compiler.watchFileSystem.constructor.name, aggregateTimeout: 200, writes, done, rebuilds: done.length - 1};
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
