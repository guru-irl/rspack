// Synthetic fixture for runtime spec memory: ROUTES lazily loaded routes all import one library of
// LIB modules, so split chunks moves the library into one chunk that all ROUTES chunks share.
const fs = require("fs");
const path = require("path");
const ROUTES = Number(process.env.ROUTES || 3000);
const LIB = Number(process.env.LIB || 600);
const dir = path.join(__dirname, "groups", "src");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
const filler = `// ${"filler text ".repeat(8)}\n`.repeat(4);
for (let i = 0; i < LIB; i++) {
  fs.writeFileSync(path.join(dir, "lib", `m${i}.js`), `export const m${i} = (x) => x + ${i};\n${filler}`);
}
fs.writeFileSync(path.join(dir, "lib", "index.js"),
  [...Array(LIB)].map((_, i) => `export { m${i} } from './m${i}.js';`).join("\n") + "\n");
for (let r = 0; r < ROUTES; r++) {
  fs.writeFileSync(path.join(dir, "routes", `r${r}.js`),
    `import * as lib from '../lib/index.js';\nexport default () => lib.m${r % LIB}(${r});\n`);
}
fs.writeFileSync(path.join(dir, "index.js"),
  `export const routes = [\n${[...Array(ROUTES)].map((_, r) => `  () => import('./routes/r${r}.js'),`).join("\n")}\n];\n`);
console.log(`generated ${ROUTES} routes and ${LIB + 1} library modules in ${dir}`);
