import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { rspack } = require('@rspack/core');
const arm = process.argv[2];
const base = process.cwd();
const root = path.resolve('cwd-check-fixture');
const packageRoot = path.resolve('variants', arm, 'package');
const { createUnplugin } = await import(pathToFileURL(path.join(packageRoot, 'dist/index.mjs')));
for (const dir of ['a', 'b']) fs.mkdirSync(path.join(root, dir, 'src'), { recursive: true });
const filter = { id: { include: ['src/**/*.ts'], exclude: ['src/rejected.ts'] } };
let accepted = { load: [], transform: [] };
let built = 0;
const definition = { name: 'synthetic-cwd-check', load: { filter, handler(id) { accepted.load.push(path.relative(root, id)); return null; } }, transform: { filter, handler(code, id) { accepted.transform.push(path.relative(root, id)); return code; } } };
const plugin = createUnplugin(() => definition).rspack();
const config = { mode: 'development', context: root, entry: './entry.mjs', devtool: false, output: { path: path.join(root, 'output'), filename: 'bundle.js' }, cache: false, module: { rules: [{ test: /\.ts$/, type: 'javascript/auto' }] }, plugins: [plugin, { apply(compiler) { compiler.hooks.thisCompilation.tap('CwdCheck', compilation => { compilation.hooks.buildModule.tap('CwdCheck', () => built++); }); } }], infrastructureLogging: { level: 'error' }, stats: 'none' };
const rows = [];
let compiler;
try {
  for (const [index, cwd] of ['a', 'b'].entries()) {
    fs.writeFileSync(path.join(root, 'entry.mjs'), "import './a/src/accepted.ts';\nimport './a/src/rejected.ts';\nimport './b/src/accepted.ts';\nimport './b/src/rejected.ts';\n" + '\n'.repeat(index + 1));
    for (const dir of ['a', 'b']) for (const name of ['accepted', 'rejected']) fs.writeFileSync(path.join(root, dir, 'src', `${name}.ts`), 'export const value = 1;\n' + '\n'.repeat(index + 1));
    process.chdir(path.join(root, cwd));
    accepted = { load: [], transform: [] };
    built = 0;
    compiler ??= rspack(config);
    const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)));
    if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
    for (const kind of ['load', 'transform']) accepted[kind].sort();
    rows.push({ cwd, accepted, built, output_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'output/bundle.js'))).digest('hex') });
    assert.equal(built, 5, 'both builds must execute all five modules');
  }
  console.log(JSON.stringify({ arm, same_compiler: true, same_plugin_instance: true, rows }));
  fs.writeFileSync(path.join(base, 'results', `cwd-${arm}.json`), JSON.stringify({ arm, same_compiler: true, same_plugin_instance: true, rows }, null, 2));
} finally {
  if (compiler) await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
  process.chdir(base);
}
