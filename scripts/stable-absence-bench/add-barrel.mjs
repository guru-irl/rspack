import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const dir = path.join(root, 'barrel');
fs.mkdirSync(dir, { recursive: true });
const files = {
  'package.json': '{"sideEffects":false}\n',
  'index.js': 'export { value } from "./constants.js";\nexport { helper } from "./helper.js";\nexport { unusedHook } from "./unused-hook.js";\n',
  'constants.js': 'export const value = "cold";\n',
  'helper.js': 'export const helper = () => "helper";\n',
  'second.js': 'export { value } from "./constants.js";\n',
  'unused-hook.js': 'import { value } from "./second.js";\nexport const unusedHook = () => value;\n',
};
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
const entry = path.join(root, 'entry.js');
const marker = 'globalThis.barrelResult';
const source = fs.readFileSync(entry, 'utf8');
if (source.includes(marker)) throw new Error('Barrel variant is already installed');
fs.appendFileSync(entry, '\nimport { value, helper } from "./barrel/index.js";\nglobalThis.barrelResult = value + helper();\n');
console.log('Added a side-effect-free barrel with used and unused exports');
