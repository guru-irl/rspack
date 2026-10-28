'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const count = Number(process.env.M2_FILES);
const folders = Number(process.env.M2_FOLDERS);
assert([40000, 80000, 160000].includes(count));
assert([1000, 3000, 6000].includes(folders));
fs.mkdirSync(process.argv[2], {recursive: true});
const root = fs.realpathSync(process.argv[2]);
const files = [], contexts = [], past = new Date(Date.now() - 60000);
for (let i = 0; i < folders; i++) {
  const dir = path.join(root, 'contexts', String(i));
  fs.mkdirSync(dir, {recursive: true});
  contexts.push(dir);
}
for (let i = 0; i < count; i++) {
  const file = path.join(contexts[i % folders], `file-${i}.txt`);
  fs.writeFileSync(file, 'original');
  fs.utimesSync(file, past, past);
  files.push(file);
}
for (let i = 0; i <= 21; i++) {
  const file = path.join(root, `ready-${i}.txt`);
  fs.writeFileSync(file, 'ready');
  fs.utimesSync(file, past, past);
}
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({files, contexts}));
console.log(JSON.stringify({files: count, contexts: folders}));
