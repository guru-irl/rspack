import fs from 'node:fs';
import {createHash} from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
export function canonicalEmission(file) {
  const source = fs.readFileSync(file, 'utf8');
  const headers = [...source.matchAll(/^"(\.\/[^"\n]+)"\([^\n]*\) \{\n/gm)];
  if (headers.length < 60000) throw new Error(`Unrecognized module table: ${headers.length} headers`);
  const ending = '\n\n},\n\n});\n';
  const endingStart = source.indexOf(ending, headers.at(-1).index);
  if (endingStart < 0) throw new Error('Unrecognized module table ending');
  const tableEnd = endingStart + ending.indexOf('\n});');
  const modules = new Map();
  for (let i = 0; i < headers.length; i++) {
    const id = headers[i][1];
    if (modules.has(id)) throw new Error(`Duplicate module id ${id}`);
    const end = i + 1 < headers.length ? headers[i + 1].index : tableEnd;
    modules.set(id, hash(source.slice(headers[i].index, end)));
  }
  const bodyHashes = [...modules].sort(([a], [b]) => a.localeCompare(b));
  return {moduleBodies: modules.size, moduleMapSha256: hash(JSON.stringify(bodyHashes)), prefixSha256: hash(source.slice(0, headers[0].index)), runtimeSha256: hash(source.slice(tableEnd))};
}
