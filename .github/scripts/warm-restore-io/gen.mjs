import fs from 'node:fs';
import path from 'node:path';
const root = process.env.FIXTURE;
const count = Number(process.env.MODULES || 10000);
const bytes = Number(process.env.SOURCE_BYTES || 120000);
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
const imports = [];
for (let i = 0; i < count; i++) {
  const head = `export default ${i};\n/* public synthetic padding ${i} `;
  fs.writeFileSync(path.join(root, 'src', `m${i}.js`), head + 'abcdef0123456789'.repeat(Math.ceil(bytes / 16)).slice(0, bytes - head.length - 3) + '*/\n');
  imports.push(`import m${i} from './m${i}.js';`);
}
fs.writeFileSync(path.join(root, 'src/index.js'), imports.join('\n') + '\nconsole.log([' + Array.from({ length: count }, (_, i) => `m${i}`).join(',') + '].reduce((a,b)=>a+b,0));\n');
console.log(JSON.stringify({ count, bytes, total: count * bytes }));
