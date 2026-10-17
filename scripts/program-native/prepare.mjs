import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const noopLoaders = Number(process.argv[3] || 1);
if (![1, 5].includes(noopLoaders)) throw new Error('Expected 1 or 5 no-op loaders');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({noopLoaders}));
let entry = 'let sum = 0;\n';
for (let group = 0; group < 100; group++) {
  const dir = path.join(root, 'src', `g${group}`);
  fs.mkdirSync(dir, { recursive: true });
  let aggregate = 'let sum = 0;\n';
  for (let item = 0; item < 600; item++) {
    let source = `const seed = ${group * 600 + item};\n`;
    for (let k = 0; k < 24; k++) source += `function helper${k}(value) { const label = 'generic-value-${k}'; return value + label.length; }\n`;
    source += 'module.exports = seed;\n';
    fs.writeFileSync(path.join(dir, `m${item}.js`), source);
    aggregate += `sum += require('./m${item}.js');\n`;
  }
  fs.writeFileSync(path.join(dir, 'index.js'), aggregate + 'module.exports = sum;\n');
  entry += `sum += require('./src/g${group}/index.js');\n`;
}
fs.mkdirSync(path.join(root, 'typed'), { recursive: true });
for (let item = 0; item < 600; item++) {
  fs.writeFileSync(path.join(root, 'typed', `t${item}.ts`), `const value: number = ${item};\nexport default value;\n`);
  entry += `sum += require('./typed/t${item}.ts').default;\n`;
}
fs.writeFileSync(path.join(root, 'entry.js'), entry + 'globalThis.fixtureResult = sum;\n');
for (let index = 0; index < noopLoaders; index++) {
  const name = index === 0 ? 'noop.cjs' : `noop-${index}.cjs`;
  fs.writeFileSync(path.join(root, name), `module.exports = function(source, map) { globalThis.loaderCalls.noop++; this.callback(null, source, map); };\n`);
}
const parserRoot = path.resolve('bench-data/parser/node_modules');
fs.writeFileSync(path.join(root, 'ast.cjs'), `const acorn = require(${JSON.stringify(path.join(parserRoot, 'acorn'))});\nconst generate = require(${JSON.stringify(path.join(parserRoot, 'escodegen'))}).generate;\nmodule.exports = function(source) { globalThis.loaderCalls.ast++; return generate(acorn.parse(source, {ecmaVersion: 2022, sourceType: 'script'})); };\n`);
fs.writeFileSync(path.join(root, 'rewrite.cjs'), `module.exports = function(source) { globalThis.loaderCalls.rewrite++; return source.replace(/generic-value-(\\d+)/g, 'generic-token-$1'); };\n`);
console.log(JSON.stringify({modules: 60701, noopLoaders, leafSourceBytes: fs.statSync(path.join(root, 'src/g0/m0.js')).size}));
