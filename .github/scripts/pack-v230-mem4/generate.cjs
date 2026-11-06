const fs = require("fs");
const path = require("path");

const profile = process.argv[2];
if (!new Set(["rope", "arena"]).has(profile)) throw new Error("expected rope or arena profile");
const count = Number(process.env.MODULES || (profile === "rope" ? 2500 : 12000));
const refs = Number(process.env.REFERENCES || 192);
const queryBytes = Number(process.env.QUERY_BYTES || 2048);
for (const n of [count, refs, queryBytes]) {
  if (!Number.isInteger(n) || n < 1) throw new Error("fixture sizes must be positive integers");
}
const root = path.join(__dirname, "template", "src");
if (fs.existsSync(root)) throw new Error(`fixture already exists: ${root}`);
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "shared.js"), "export function base(x) { return x * 2 + 1; }\n");
const imports = [];
const calls = [];
if (profile === "rope") {
  for (let i = 0; i < count; i++) {
    const name = `item${i}`;
    const expressions = Array.from({ length: refs }, (_, j) => `base(x + ${j})`).join(" +\n    ");
    const source = `import { base } from './shared.js';\nexport function ${name}(x) {\n  return ${expressions};\n}\n`;
    fs.writeFileSync(path.join(root, `${name}.js`), source);
    imports.push(`import { ${name} } from './${name}.js';`);
    calls.push(`${name}(${i % 7})`);
  }
} else {
  const filler = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(Math.ceil(queryBytes / 36)).slice(0, queryBytes);
  for (let i = 0; i < count; i++) {
    const name = `item${i}`;
    const request = `./shared.js?${i}-${filler}`;
    imports.push(`import { base as ${name} } from ${JSON.stringify(request)};`);
    calls.push(`${name}(${i % 7})`);
  }
}
fs.writeFileSync(path.join(root, "index.js"), `${imports.join("\n")}\nglobalThis.result = [${calls.join(",\n")}];\n`);
console.log(JSON.stringify({ profile, count, referencesPerModule: profile === "rope" ? refs : 0, queryBytes: profile === "arena" ? queryBytes : 0 }));
