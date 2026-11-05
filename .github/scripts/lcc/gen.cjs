// Generates a synthetic project with many async chunks for LimitChunkCountPlugin.
// Usage: node gen.cjs <dir> '<spec json>'
// spec: {
//   asyncChunks: number of non-empty dynamic-import chunks,
//   emptyChunks: number of dynamic imports of modules the entry already has (empty chunks),
//   commons: number of modules shared between async chunks,
//   commonsPerChunk: commons each async module imports,
//   commonSize: characters in each common module's payload,
//   names: give every async chunk a webpackChunkName,
//   secondEntry: add a second entry that imports every third async module too,
// }
const fs = require("node:fs");
const path = require("node:path");

const [dir, specJson] = process.argv.slice(2);
const spec = {
  asyncChunks: 0,
  emptyChunks: 0,
  commons: 0,
  commonsPerChunk: 0,
  commonSize: 200,
  names: false,
  secondEntry: false,
  ...JSON.parse(specJson),
};

let state = 0x9e3779b9;
function random() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
}

function payload(length) {
  const words = ["alpha", "beta", "gamma", "delta", "omega", "sigma", "kappa"];
  let text = "";
  while (text.length < length) {
    text += `${words[Math.floor(random() * words.length)]}${Math.floor(random() * 1000)} `;
  }
  return JSON.stringify(text.slice(0, length));
}

const src = path.join(dir, "src");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(src, { recursive: true });

for (let j = 0; j < spec.commons; j++) {
  fs.writeFileSync(
    path.join(src, `common${j}.js`),
    `export const common${j} = ${payload(spec.commonSize)};\n`,
  );
}

for (let k = 0; k < spec.emptyChunks; k++) {
  fs.writeFileSync(path.join(src, `shared${k}.js`), `export const shared${k} = ${k};\n`);
}

for (let i = 0; i < spec.asyncChunks; i++) {
  const imports = [];
  const names = [];
  for (let c = 0; c < spec.commonsPerChunk && spec.commons > 0; c++) {
    const j = Math.floor(random() * spec.commons);
    if (!names.includes(`common${j}`)) {
      imports.push(`import { common${j} } from "./common${j}.js";`);
      names.push(`common${j}`);
    }
  }
  const body = payload(100 + Math.floor(random() * 4900));
  fs.writeFileSync(
    path.join(src, `async${i}.js`),
    `${imports.join("\n")}\nexport default function async${i}() {\n  return [${[body, ...names].join(", ")}];\n}\n`,
  );
}

function dynamicImport(file, name) {
  const comment = spec.names && name ? `/* webpackChunkName: ${JSON.stringify(name)} */ ` : "";
  return `() => import(${comment}"./${file}")`;
}

const entry = [];
for (let k = 0; k < spec.emptyChunks; k++) {
  entry.push(`import { shared${k} } from "./shared${k}.js";`);
}
entry.push("export const loaders = [");
for (let i = 0; i < spec.asyncChunks; i++) {
  entry.push(`  ${dynamicImport(`async${i}.js`, `async-${i}`)},`);
}
for (let k = 0; k < spec.emptyChunks; k++) {
  entry.push(`  ${dynamicImport(`shared${k}.js`, `empty-${k}`)},`);
}
entry.push("];");
const sharedValues = Array.from({ length: spec.emptyChunks }, (_, k) => `shared${k}`);
entry.push(`export const shared = [${sharedValues.join(", ")}];`);
entry.push("globalThis.__lcc = { loaders, shared };");
fs.writeFileSync(path.join(src, "index.js"), `${entry.join("\n")}\n`);

if (spec.secondEntry) {
  const other = ["export const loaders = ["];
  for (let i = 0; i < spec.asyncChunks; i += 3) {
    other.push(`  ${dynamicImport(`async${i}.js`, `async-${i}`)},`);
  }
  other.push("];");
  other.push("globalThis.__lccOther = loaders;");
  fs.writeFileSync(path.join(src, "other.js"), `${other.join("\n")}\n`);
}

console.log(JSON.stringify({ dir, spec, files: fs.readdirSync(src).length }));
