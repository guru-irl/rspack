// Generates the parity fixture under template/src: TS leaves with UTF-16 wide and surrogate-pair text,
// shared modules, and lazily loaded routes so split chunks and loader source maps are exercised.
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "template", "src");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const SHARED = 60, ROUTES = 24, LEAF = 300;
const filler = `// ${"filler text ".repeat(16)}\n`.repeat(8);
for (let i = 0; i < LEAF; i++) {
  const label = (i % 7 === 0 ? "ünïcödé 🚀 漢字 " : "") + "leaf " + i;
  fs.writeFileSync(path.join(dir, `leaf-${i}.ts`),
    `export interface L${i} { id: number; label: string }\n` +
    `export function leaf${i}(x: number): L${i} {\n  const label: string = ${JSON.stringify(label)};\n  return { id: x * ${i + 1}, label };\n}\n` + filler);
}
for (let i = 0; i < SHARED; i++) {
  const imps = [...Array(5)].map((_, k) => (i * 5 + k) % LEAF);
  fs.writeFileSync(path.join(dir, `shared-${i}.ts`),
    imps.map(k => `import { leaf${k} } from './leaf-${k}';`).join("\n") +
    `\nexport const shared${i} = (n: number): string => [${imps.map(k => `leaf${k}(n).label`).join(", ")}].join(${JSON.stringify(i % 5 === 0 ? " → " : "|")});\n` + filler);
}
for (let r = 0; r < ROUTES; r++) {
  const sh = [...Array(6)].map((_, k) => (r * 3 + k) % SHARED);
  fs.writeFileSync(path.join(dir, `route-${r}.ts`),
    sh.map(k => `import { shared${k} } from './shared-${k}';`).join("\n") +
    `\nexport default function route${r}(): string { return [${sh.map(k => `shared${k}(${r})`).join(", ")}].join("\\n"); }\n`);
}
fs.writeFileSync(path.join(dir, "index.ts"),
  `import { shared0 } from './shared-0';\n` +
  `const routes: Array<() => Promise<{ default: () => string }>> = [${[...Array(ROUTES)].map((_, r) => `() => import('./route-${r}')`).join(", ")}];\n` +
  `export async function main(): Promise<string[]> { const out: string[] = [shared0(1)]; for (const r of routes) out.push((await r()).default()); return out; }\nmain();\n`);
console.log(`generated ${LEAF + SHARED + ROUTES + 1} modules in ${dir}`);
