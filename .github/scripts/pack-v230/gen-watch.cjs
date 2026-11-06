// Generates the watch fixture for the previous-assets A/B: an entry that lazily loads ROUTES route
// modules. Every route has 80 small functions and imports the tiny stamp.js, which stays inside each
// route chunk (below minSize), so an edit to stamp.js changes every route chunk and its source map.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "watchfx");
const N = Number(process.env.ROUTES || 3000);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, "src", "routes"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "stamp.js"), "export const stamp = 0;\n");
for (let i = 0; i < N; i++) {
  let body = 'import { stamp } from "../stamp.js";\n';
  for (let j = 0; j < 80; j++) body += `export function f${j}(x) { return x + ${i * 80 + j} + stamp + "route ${i} fn ${j}"; }\n`;
  fs.writeFileSync(path.join(root, "src", "routes", `r${i}.js`), body);
}
let index = "";
for (let i = 0; i < N; i++) index += `export const load${i} = () => import("./routes/r${i}.js");\n`;
fs.writeFileSync(path.join(root, "src", "index.js"), index);
console.log(`generated ${N} routes in ${root}`);
