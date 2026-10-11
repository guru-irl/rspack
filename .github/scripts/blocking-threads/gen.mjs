import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const count = 20000;
function write(name, text) {
  const dest = path.join(root, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}
const names = Array.from({ length: count }, (_, i) => `src/group${Math.floor(i / 1000)}/branch${Math.floor(i / 100) % 10}/leaf${Math.floor(i / 10) % 10}/m${i}.js`);
for (let i = 0; i < count; i++) {
  const children = [2 * i + 1, 2 * i + 2].filter(j => j < count);
  const imports = children.map((j, k) => {
    let rel = path.posix.relative(path.posix.dirname(names[i]), names[j]);
    if (!rel.startsWith('.')) rel = './' + rel;
    return `import { value as child${k} } from '${rel}';`;
  }).join('\n');
  const padding = `module-${i}-` + 'public-synthetic-content-'.repeat(65);
  write(names[i], `${imports}\nimport { value as pkg } from 'synthetic-pkg-${i % 300}';\nexport const label = ${JSON.stringify(padding)};\nexport const value = ${i} + pkg + label.length${children.map((_, k) => ' + child' + k).join('')};\n`);
}
for (let i = 0; i < 300; i++) {
  const p = `node_modules/synthetic-pkg-${i}`;
  write(`${p}/package.json`, JSON.stringify({ name: `synthetic-pkg-${i}`, version: '1.0.0', main: 'nested/lib/index.js' }));
  write(`${p}/nested/lib/index.js`, `export { value } from './deeper/value.js';\n`);
  write(`${p}/nested/lib/deeper/value.js`, `export const value = ${i};\n`);
}
write('client.js', `import { value } from './${names[0]}';\nconsole.log('client', value);\n`);
write('server.js', `import { value } from './${names[0]}';\nconsole.log('server', value);\n`);
write('fixture.json', JSON.stringify({ modules: count, packages: 300, moduleBytes: [1600, 2400], graph: 'binary tree, all modules reachable' }));
console.log(JSON.stringify({ root, modules: count, packages: 300 }));
