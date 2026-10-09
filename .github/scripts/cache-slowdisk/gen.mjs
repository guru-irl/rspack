// Generates a synthetic project for legacy vs newCache warm-start comparisons.
// Usage: node gen.mjs [modules=3000]
// Layout:
//   project/package.json            large root package.json (copied into every resolution's description data)
//   project/src/dN/mI.js            JS modules, 10 per directory, each importing 3 later modules, a CSS file
//                                   every 5th module, and 2 of the fake packages
//   project/src/dN/mI.css           CSS files (css/auto rule)
//   project/node_modules/pkgK/      fake packages with a large package.json and 5 internal files
//   project/loaders/tag-loader.cjs  trivial loader applied to every src .js file
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = process.env.FIXTURE;
if (!root) throw new Error('set FIXTURE');
const N = Number(process.argv[2] ?? 3000);
const PER_DIR = 10;
const PKGS = 20;

fs.rmSync(root, { recursive: true, force: true });
const w = (p, s) => {
  const f = path.join(root, p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};

// Realistic large app package.json: many deps and scripts, about 30 KB.
const bigFields = (prefix, n) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`${prefix}-${i}-${'x'.repeat(20)}`, `^${i}.0.0`]),
  );
w(
  'package.json',
  JSON.stringify(
    {
      name: 'repro-warm',
      version: '1.0.0',
      private: true,
      sideEffects: ['*.css'],
      dependencies: bigFields('dep', 300),
      devDependencies: bigFields('dev', 300),
      scripts: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`script${i}`, `node ./scripts/s${i}.js --flag ${i}`]),
      ),
    },
    null,
    2,
  ),
);

for (let k = 0; k < PKGS; k++) {
  w(
    `node_modules/pkg${k}/package.json`,
    JSON.stringify(
      {
        name: `pkg${k}`,
        version: '1.0.0',
        main: 'index.js',
        sideEffects: false,
        description: 'd'.repeat(2000),
        keywords: Array.from({ length: 200 }, (_, i) => `kw${i}`),
        exports: Object.fromEntries(
          Array.from({ length: 150 }, (_, i) => [`./sub${i}`, `./lib/sub${i}.js`]).concat([
            ['.', './index.js'],
          ]),
        ),
      },
      null,
      2,
    ),
  );
  let idx = '';
  for (let j = 0; j < 5; j++) {
    w(`node_modules/pkg${k}/lib/sub${j}.js`, `export const v${j} = ${k * 10 + j};\n`);
    idx += `export { v${j} } from './lib/sub${j}.js';\n`;
  }
  w(`node_modules/pkg${k}/index.js`, idx);
}

w(
  'loaders/tag-loader.cjs',
  `module.exports = function (source) { return source + '\\n/* tagged */\\n'; };\n`,
);

const file = (i) => `src/d${Math.floor(i / PER_DIR)}/m${i}`;
const rel = (from, to) => {
  let r = path.relative(path.dirname(from), to);
  if (!r.startsWith('.')) r = './' + r;
  return r;
};

for (let i = 0; i < N; i++) {
  const me = file(i);
  let s = '';
  const kids = [2 * i + 1, 2 * i + 2, i + 7].filter((j) => j < N);
  kids.forEach((j, n) => {
    s += `import k${n} from '${rel(me, file(j))}.js';\n`;
  });
  s += `import { v0 as p0 } from 'pkg${i % PKGS}';\n`;
  s += `import { v1 as p1 } from 'pkg${(i * 7 + 3) % PKGS}';\n`;
  if (i % 5 === 0) {
    w(`${me}.css`, `.c${i} { color: red; padding: ${i % 10}px; }\n.c${i} .inner { margin: 1px; }\n`);
    s += `import './m${i}.css';\n`;
  }
  s += `export default ${kids.map((_, n) => `k${n}`).concat(['p0', 'p1', i]).join(' + ')};\n`;
  w(`${me}.js`, s);
}
w('src/index.js', `import m0 from './d0/m0.js';\nconsole.log(m0);\n`);
console.log(`generated ${N} modules in ${root}`);
