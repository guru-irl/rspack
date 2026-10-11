'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const count = Number(process.env.MODULE_COUNT || 45000);
const lines = Number(process.env.MODULE_LINES || 48);
fs.mkdirSync(root, { recursive: true });
// Deterministic arithmetic, strings and functions, with no external input.
for (let group = 0; group < Math.ceil(count / 100); group++) {
  const dir = path.join(root, `g${group}`);
  fs.mkdirSync(dir, { recursive: true });
  const imports = [];
  for (let i = group * 100; i < Math.min(count, (group + 1) * 100); i++) {
    const source = [`export const moduleId = ${i};`, `export const label = 'synthetic-module-${i}';`];
    for (let j = 0; j < lines; j++) {
      source.push(`export function value${j}(input) { const text = 'public-generated-${i}-${j}-abcdefghijklmnopqrstuvwxyz'; return ((input + ${i + j}) * ${j + 3}) ^ text.length; }`);
    }
    source.push(`export default function run(input) { return value0(input) + value${lines - 1}(input); }`);
    fs.writeFileSync(path.join(dir, `m${i}.js`), source.join('\n') + '\n');
    imports.push(`import f${i} from './m${i}.js';`);
  }
  imports.push(`export default function group(input) { return ${Array.from({ length: Math.min(100, count - group * 100) }, (_, j) => `f${group * 100 + j}(input)`).join(' + ')}; }`);
  fs.writeFileSync(path.join(dir, 'index.js'), imports.join('\n') + '\n');
}
const imports = Array.from({ length: Math.ceil(count / 100) }, (_, g) => `import g${g} from './g${g}/index.js';`);
const sum = Array.from({ length: Math.ceil(count / 100) }, (_, g) => `g${g}(1)`).join(' + ');
fs.writeFileSync(path.join(root, 'client.js'), imports.join('\n') + `\nglobalThis.syntheticClient = ${sum};\n`);
fs.writeFileSync(path.join(root, 'server.js'), imports.join('\n') + `\nexport function render() { return ${sum}; }\n`);
fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ count, lines, groups: Math.ceil(count / 100), shared: true }));
console.log(JSON.stringify({ generated: root, count, lines }));
