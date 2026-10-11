'use strict';
const fs = require('node:fs');
const path = require('node:path');
function moduleText(i, step = 0) {
  const records = Array.from({ length: 22 }, (_, j) => `  { key: "item-${i}-${j}", label: "Public catalogue entry ${j}", route: "/catalog/${i}/${j}", note: "Display \\"quoted\\" label and \\\\ path café 😀", weight: ${j + 1} },`).join('\n');
  const data = `// Public deterministic catalogue module ${i}\nconst records = [\n${records}\n];\nfunction render(input) {\n  const limit = input && input.limit || 12;\n  return records.slice(0, limit).map(row => ({\n    id: row.key, title: row.label, href: row.route,\n    score: row.weight + ${String(step).padStart(6, '0')}, note: row.note\n  }));\n}\n`;
  // Fixed-width valid numeric expression: padded with spaces, never legacy octal.
  const text = data.replace(`+ ${String(step).padStart(6, '0')}`, `+ ${String(step).padStart(6, ' ')}`);
  return text + (i % 2 ? 'export { render, records };\n' : 'module.exports = { render, records };\n');
}
function generate(root, count = 30000) {
  fs.mkdirSync(path.join(root, 'modules'), { recursive: true });
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    const source = moduleText(i);
    bytes += Buffer.byteLength(source);
    fs.writeFileSync(path.join(root, 'modules', `m${String(i).padStart(5, '0')}.js`), source);
  }
  fs.writeFileSync(path.join(root, 'entry.js'), Array.from({ length: count }, (_, i) => `exports.m${i} = require('./modules/m${String(i).padStart(5, '0')}.js');`).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'public-sourcemap-fixture', private: true }));
  return { count, inputBytes: bytes };
}
module.exports = { moduleText, generate };
if (require.main === module) console.log(JSON.stringify(generate(path.resolve(process.argv[2]), Number(process.argv[3] || 30000))));
