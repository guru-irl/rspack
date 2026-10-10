import fs from 'node:fs';
import path from 'node:path';
const [stock, oracle] = process.argv.slice(2);
const differences = [];
let compared = 0;
for (const file of fs.readdirSync(stock).filter(f => /-(?:cold|\d+-(?:edit|revert))\.json$/.test(f))) {
  const a = JSON.parse(fs.readFileSync(path.join(stock, file)));
  const b = JSON.parse(fs.readFileSync(path.join(oracle, file)));
  const names = new Set([...Object.keys(a.outputs), ...Object.keys(b.outputs)]);
  for (const name of names) if (a.outputs[name] !== b.outputs[name]) differences.push({ file, name, stock: a.outputs[name], oracle: b.outputs[name] });
  compared++;
}
console.log(JSON.stringify({ compared, byteIdentical: differences.length === 0, differences }, null, 2));
if (compared === 0 || differences.length) process.exitCode = 1;
