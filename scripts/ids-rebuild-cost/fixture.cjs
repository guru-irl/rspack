'use strict';
const fs = require('node:fs');
const path = require('node:path');

function generate(root, target) {
  const routes = target === 60000 ? 3000 : target === 15000 ? 750 : 50;
  const leafCount = target - routes - 121;
  const perRoute = Math.floor(leafCount / routes);
  const extra = leafCount % routes;
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(root, 'loader.cjs'), `module.exports = function(source) { this.cacheable(); return source + '\\n// public synthetic JS loader\\n'; };\n`);
  for (let g = 0; g < 4; g++) {
    fs.mkdirSync(path.join(src, `shared${g}`), { recursive: true });
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(src, `shared${g}/m${i}.js`), `export default ${g * 20 + i};\n`);
  }
  fs.mkdirSync(path.join(src, 'styles'), { recursive: true });
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(src, `styles/s${i}.css`), `.synthetic-${i} { color: rgb(${i}, 20, 30); padding: ${i % 8}px; }\n`);
  let entry = 'export const routes = [\n';
  for (let r = 0; r < routes; r++) {
    const dir = path.join(src, `route${r}`);
    fs.mkdirSync(dir, { recursive: true });
    let code = `import '../styles/s${r % 40}.css';\n`;
    const values = [];
    for (let i = 0; i < perRoute + (r < extra ? 1 : 0); i++) {
      fs.writeFileSync(path.join(dir, `leaf${i}.js`), r === 0 && i === 0 ? 'export default "ids-benchmark-edit-initial";\n' : `export default ${r * perRoute + i};\n`);
      code += `import v${i} from './leaf${i}.js';\n`;
      values.push(`v${i}`);
    }
    for (let g = 0; g < 4; g++) {
      code += `import s${g} from '../shared${g}/m${r % 20}.js';\n`;
      values.push(`s${g}`);
    }
    code += `export default [${values.join(',')}];\n`;
    fs.writeFileSync(path.join(dir, 'index.js'), code);
    // Unnamed async chunks exercise ID allocation instead of explicit chunk names.
    entry += `() => import('./route${r}/index.js'),\n`;
  }
  fs.writeFileSync(path.join(src, 'index.js'), entry + '];\n');
  return { target, routes, perRoute, generatedModules: target };
}
module.exports = { generate };
