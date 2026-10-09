import fs from 'node:fs';
import path from 'node:path';
const n = 60000;
const root = path.resolve('fixture/src');
fs.mkdirSync(path.join(root, 'routes'), { recursive: true });
const name = i => `${i % 100 < 3 ? 'routes/' : ''}m${i}.ts`;
let entry = '';
for (let i = 0; i < n; i++) {
  const file = path.join(root, name(i));
  let code = '';
  for (let j = 1; j <= 3 && i % 100 >= j; j++) {
    let relative = path.relative(path.dirname(file), path.join(root, name(i - j)));
    if (!relative.startsWith('.')) relative = './' + relative;
    code += `import { v as x${j} } from '${relative}';\n`;
  }
  code += `export const v = ${i % 100 === 0 ? 1 : Array.from({ length: Math.min(3, i % 100) }, (_, j) => 'x' + (j + 1)).join(' + ')};\n`;
  fs.writeFileSync(file, code);
  entry += `import { v as v${i} } from './${name(i)}';\n`;
}
entry += 'console.log([' + Array.from({ length: n }, (_, i) => 'v' + i).join(', ') + '].length);\n';
fs.writeFileSync(path.join(root, 'index.ts'), entry);
console.log(`${n} synthetic leaf modules; 1800 route modules; one shared fixture`);
