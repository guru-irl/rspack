import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--modules')) {
  throw new Error('Usage: node gen.mjs [--modules <positive integer>]');
}
const n = args.length ? Number(args[1]) : 60000;
if (!Number.isSafeInteger(n) || n < 1) throw new Error('--modules must be a positive integer');
const src = path.join(root, 'src');
// Regeneration overwrites this fixture-owned tree, never external paths.
fs.rmSync(src, { recursive: true, force: true });
fs.mkdirSync(src, { recursive: true });
const roots = Array.from({ length: 52 }, () => []);
const sets = Array.from({ length: 200 }, (_, i) => {
  const cluster = i % 4;
  const width = 2 + (Math.floor(i / 4) % 7);
  const start = Math.floor(i / 28) % 7;
  return Array.from({ length: width }, (_, j) => cluster * 13 + ((start + j) % 13));
});
for (let i = 0; i < n; i++) {
  const pkg = `p${String(Math.floor(i * 120 / n)).padStart(3, '0')}`;
  const rel = `packages/${pkg}/m${String(i).padStart(5, '0')}.js`;
  const file = path.join(src, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `export const value = ${i};\n`);
  for (const r of sets[i % sets.length]) roots[r].push(i);
}
for (let r = 0; r < 52; r++) {
  const imports = roots[r].map(i => {
    const pkg = `p${String(Math.floor(i * 120 / n)).padStart(3, '0')}`;
    return `import { value as v${i} } from './packages/${pkg}/m${String(i).padStart(5, '0')}.js';`;
  });
  fs.writeFileSync(path.join(src, `root${r}.js`), `${imports.join('\n')}\nglobalThis.results = [${roots[r].map(i => `v${i}`).join(',')}];\n`);
}
for (let e = 0; e < 12; e++) {
  const asyncRoots = Array.from({ length: 40 }, (_, r) => r + 12).filter(r => r % 12 === e);
  fs.writeFileSync(path.join(src, `entry${e}.js`), `import './root${e}.js';\n${asyncRoots.map(r => `import('./root${r}.js');`).join('\n')}\n`);
}
console.log(`Generated ${n} leaf modules, 52 roots and 12 entries in src/ (no randomness).`);
