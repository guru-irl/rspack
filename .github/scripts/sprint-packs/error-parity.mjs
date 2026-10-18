import fs from 'node:fs';
import path from 'node:path';
import { rspack } from '../runtime/node_modules/@rspack/core/dist/index.js';
const resultPath = path.resolve(process.argv[2]);
const root = path.resolve('bench-data/error-fixture');
const results = {};
const cases = ['sync-throw', 'async-callback', 'async-reject', 'hook-reject', 'hook-resolve', 'output-fs'];
for (const kind of cases) {
  fs.rmSync(root, {recursive: true, force: true});
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(path.join(root, 'entry.js'), 'module.exports = 42;\n');
  const loaders = {
    'sync-throw': "module.exports = function() { throw new Error('generic synchronous loader failure'); };\n",
    'async-callback': "module.exports = function() { const callback = this.async(); setImmediate(() => callback(new Error('generic asynchronous callback failure'))); };\n",
    'async-reject': "module.exports = async function() { throw new Error('generic rejected loader failure'); };\n"
  };
  if (loaders[kind]) fs.writeFileSync(path.join(root, 'loader.cjs'), loaders[kind]);
  let hookCalls = 0, outputCalls = 0;
  const compiler = rspack({
    mode: 'development', context: root, entry: './entry.js', target: 'node', cache: false, devtool: false,
    output: {path: path.join(root, 'out'), filename: 'bundle.cjs'},
    optimization: {minimize: false, concatenateModules: false, moduleIds: 'named', chunkIds: 'named'},
    module: {rules: loaders[kind] ? [{test: /\.js$/, use: path.join(root, 'loader.cjs')}] : []},
    plugins: [{apply(compiler) {
      if (kind.startsWith('hook-')) compiler.hooks.finishMake.tapPromise('GenericPromiseCheck', async () => {
        hookCalls++;
        await new Promise(resolve => setImmediate(resolve));
        if (kind === 'hook-reject') throw new Error('generic promise hook rejection');
      });
    }}]
  });
  if (kind === 'output-fs') {
    const output = {};
    for (const name of ['mkdir', 'writeFile', 'readFile', 'stat', 'lstat', 'readdir', 'unlink', 'rmdir']) output[name] = (...args) => {
      if (name === 'writeFile') outputCalls++;
      return fs[name](...args);
    };
    compiler.outputFileSystem = output;
    if (compiler.outputFileSystem === fs) throw Error('JS output filesystem not selected');
  }
  const {error, stats} = await new Promise(resolve => compiler.run((error, stats) => resolve({error, stats})));
  const diagnostics = stats ? stats.toJson({all: false, errors: true, errorDetails: true, warnings: true}) : null;
  const emitted = {};
  function walk(directory, prefix = '') {
    if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, item), relative = prefix + item;
      if (fs.statSync(file).isDirectory()) walk(file, relative + '/');
      else emitted[relative] = fs.readFileSync(file).toString('base64');
    }
  }
  walk(path.join(root, 'out'));
  if (kind.startsWith('hook-') && hookCalls !== 1) throw Error('Promise hook did not run');
  if (kind === 'output-fs' && outputCalls < 1) throw Error('JS output filesystem did not write');
  const shouldFail = !['hook-resolve', 'output-fs'].includes(kind);
  if (Boolean(error || stats?.hasErrors()) !== shouldFail) throw Error('Unexpected case outcome: ' + kind);
  results[kind] = {error: error ? {name: error.name, message: error.message} : null, diagnostics, emitted, hookCalls, outputCalls};
  await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
}
fs.writeFileSync(resultPath, JSON.stringify(results, null, 2) + '\n');
console.log('Error parity fixture completed: ' + cases.join(', '));
