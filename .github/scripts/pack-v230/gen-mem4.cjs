// Generate a mixed module graph with ESM barrels, side effects, CommonJS, async imports and CSS.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || 'fixture');
const count = Number(process.env.MODULES || 30000);
const width = 100;
if (!Number.isInteger(count) || count < 1) throw Error('MODULES must be a positive integer');
for (const name of ['modules', 'barrels', 'consumers', 'styles']) {
  fs.mkdirSync(path.join(root, 'src', name), { recursive: true });
}
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
  private: true,
  sideEffects: ['**/e*.js', '**/*.css'],
}));
const entry = [];
const values = [];
const mix = { barrel: 0, sideEffect: 0, commonjs: 0, dynamic: 0, css: 0 };
for (let start = 0; start < count; start += width) {
  const end = Math.min(start + width, count);
  const group = start / width;
  const kind = group % 4;
  const names = [];
  const imports = [];
  const exports = [];
  const requires = [];
  for (let i = start; i < end; i++) {
    const name = `v${i}`;
    if (kind === 1) {
      fs.writeFileSync(path.join(root, 'src', 'modules', `e${i}.js`), `globalThis.effect${i} = ${i};\n`);
      imports.push(`import '../modules/e${i}.js';`);
    } else if (kind === 2) {
      fs.writeFileSync(path.join(root, 'src', 'modules', `m${i}.cjs`), `module.exports = ${i};\n`);
      requires.push(`require('../modules/m${i}.cjs')`);
    } else {
      fs.writeFileSync(path.join(root, 'src', 'modules', `m${i}.js`), `export const ${name} = ${i};\n`);
      imports.push(`import { ${name} } from '../modules/m${i}.js';`);
      exports.push(`export { ${name} } from '../modules/m${i}.js';`);
      names.push(name);
    }
  }
  if (kind === 0) {
    mix.barrel++;
    fs.writeFileSync(path.join(root, 'src', 'barrels', `g${group}.js`), `${exports.join('\n')}\n`);
    fs.writeFileSync(path.join(root, 'src', 'consumers', `c${group}.js`), `import { ${names.join(', ')} } from '../barrels/g${group}.js';\nexport const c${group} = [${names.join(', ')}];\n`);
    entry.push(`import { c${group} } from './consumers/c${group}.js';`);
    values.push(`c${group}`);
  } else if (kind === 1) {
    mix.sideEffect++;
    fs.writeFileSync(path.join(root, 'src', 'consumers', `c${group}.js`), `${imports.join('\n')}\nexport const c${group} = ${group};\n`);
    entry.push(`import { c${group} } from './consumers/c${group}.js';`);
    values.push(`c${group}`);
  } else if (kind === 2) {
    mix.commonjs++;
    fs.writeFileSync(path.join(root, 'src', 'consumers', `c${group}.cjs`), `module.exports = [${requires.join(', ')}];\n`);
    entry.push(`import c${group} from './consumers/c${group}.cjs';`);
    values.push(`c${group}`);
  } else {
    mix.dynamic++;
    fs.writeFileSync(path.join(root, 'src', 'consumers', `c${group}.js`), `${imports.join('\n')}\nexport const c${group} = [${names.join(', ')}];\n`);
    values.push(`() => import('./consumers/c${group}.js')`);
  }
  if (group % 10 === 0) {
    mix.css++;
    fs.writeFileSync(path.join(root, 'src', 'styles', `s${group}.css`), `.fixture-${group} { color: rgb(${group % 255}, 10, 20); }\n`);
    entry.push(`import './styles/s${group}.css';`);
  }
}
fs.writeFileSync(path.join(root, 'src', 'index.js'), `${entry.join('\n')}\nglobalThis.result = [${values.join(', ')}];\n`);
console.log(JSON.stringify({ root, modules: count, groups: mix }));
