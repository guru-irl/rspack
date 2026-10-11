import fs from 'node:fs';
import path from 'node:path';

export function generate(root, { packages = 40, leaves = 700, routes = 3000, groupSize = 20 } = {}) {
  const put = (name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  put('package.json', JSON.stringify({ name: 'synthetic-incremental-precision', private: true, sideEffects: false }));
  const groups = Math.ceil(leaves / groupSize);
  for (let p = 0; p < packages; p++) {
    const base = `packages/p${p}`;
    for (let i = 0; i < leaves; i++) {
      put(`${base}/lib/l${i}.js`, `export function x_${p}_${i}(value) { return value + ${p * leaves + i}; }\n`);
      put(`${base}/consumer/c${i}.js`, `import { x_${p}_${i} } from 'PUBLIC_IMPORT_${p}_${i}';\nexport function c_${p}_${i}(value) { return x_${p}_${i}(value) * 2; }\n`);
    }
    for (let g = 0; g < groups; g++) {
      const names = [];
      for (let i = g * groupSize; i < Math.min(leaves, (g + 1) * groupSize); i++) {
        names.push(i % 2 ? `export { x_${p}_${i} } from './lib/l${i}.js';` : `export * from './lib/l${i}.js';`);
      }
      put(`${base}/b${g}.js`, names.join('\n') + '\n');
    }
    put(`${base}/index.js`, Array.from({ length: groups }, (_, g) => g % 2
      ? `export { ${Array.from({ length: Math.min(groupSize, leaves - g * groupSize) }, (_, j) => `x_${p}_${g * groupSize + j}`).join(', ')} } from './b${g}.js';`
      : `export * from './b${g}.js';`).join('\n') + '\n');
  }
  put('index.js', Array.from({ length: packages }, (_, p) => `export { x_${p}_0 } from './packages/p${p}/lib/l0.js';`).join('\n') + '\n');
  for (let r = 0; r < routes; r++) {
    const p = r % packages;
    const g = Math.floor(r / packages) % groups;
    const ids = [];
    for (const group of [g, (g + 1) % groups]) {
      for (let i = group * groupSize; i < Math.min(leaves, (group + 1) * groupSize); i++) ids.push(i);
    }
    put(`routes/r${r}.js`, ids.map(i => `import { c_${p}_${i} } from '../packages/p${p}/consumer/c${i}.js';`).join('\n')
      + `\nexport default function route(value) { return ${ids.map(i => `c_${p}_${i}(value)`).join(' + ')}; }\n`);
  }
  put('entry.js', `globalThis.syntheticRoutes = [\n${Array.from({ length: routes }, (_, r) => `() => import(/* webpackChunkName: "route-${r}" */ './routes/r${r}.js')`).join(',\n')}\n];\n`);
  const manifest = { packages, leavesPerPackage: leaves, routes, groupSize,
    sourceModulesBarrelsOn: packages * (2 * leaves + groups + 1) + routes + 2,
    sourceModulesBarrelsOff: packages * 2 * leaves + routes + 1,
    editFile: 'packages/p0/lib/l0.js' };
  put('fixture.json', JSON.stringify(manifest, null, 2));
  return manifest;
}

export function setBarrels(root, enabled, { packages = 40, leaves = 700 } = {}) {
  for (let p = 0; p < packages; p++) for (let i = 0; i < leaves; i++) {
    fs.writeFileSync(path.join(root, `packages/p${p}/consumer/c${i}.js`),
      `import { x_${p}_${i} } from '${enabled ? '../index.js' : `../lib/l${i}.js`}';\nimport { x_${p}_0 as shared } from '${enabled ? '../../../index.js' : '../lib/l0.js'}';\nexport function c_${p}_${i}(value) { return x_${p}_${i}(value) * 2 + shared(value); }\n`);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const root = path.resolve(process.argv[2]);
  const manifest = generate(root);
  setBarrels(root, true);
  console.log(JSON.stringify(manifest));
}
