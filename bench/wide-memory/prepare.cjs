'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve('.bench-wide/fixtures');
assert(!fs.existsSync(root), 'fixtures must be generated once on a fresh measurement runner');
const write = (base, file, content) => {
 const dest = path.join(base, file);
 fs.mkdirSync(path.dirname(dest), {recursive: true});
 fs.writeFileSync(dest, content);
 const past = new Date(Date.now() - 60000);
 fs.utimesSync(dest, past, past);
};
for (const scenario of ['wide', 'modules', 'symlink']) {
 const base = path.join(root, scenario);
 fs.mkdirSync(base, {recursive: true});
 write(base, 'package.json', JSON.stringify({name:`wide-fixture-${scenario}`,private:true,type:'commonjs'}));
 let entries = [], target, folders, fillerFiles;
 if (scenario === 'modules') {
  folders = 2200; fillerFiles = 0;
  for (let i=0; i<2000; i++) {
   const file = `src/g${String(Math.floor(i/10)).padStart(3,'0')}/leaf${String(i%10).padStart(2,'0')}/m${String(i).padStart(4,'0')}.js`;
   write(base, file, `module.exports = ${i};\n`);
   entries.push([`./${file}`, i]);
  }
  target = entries[0][0].slice(2);
  write(base, 'index.js', `module.exports = {value: require(${JSON.stringify(entries[0][0])}), count: 2000, entries: [${entries.map(([key]) => `[${JSON.stringify(key)}, require(${JSON.stringify(key)})]`).join(',')}]};\n`);
 } else {
  folders = 20000; fillerFiles = 40000;
  for (let i=0; i<20000; i++) {
   const folder = `ctx/d${String(i).padStart(5,'0')}`;
   write(base, `${folder}/a.txt`, `a-${i}\n`);
   write(base, `${folder}/b.txt`, `b-${i}\n`);
  }
  target = 'ctx/target.js';
  write(base, target, 'module.exports = 0;\n');
  entries.push(['./target.js', 0]);
  if (scenario === 'symlink') {
   for(let i=0; i<500; i++) {
    const name = `f${String(i).padStart(3,'0')}.js`;
    write(base, `ctx/real/${name}`, `module.exports = ${1000+i};\n`);
    entries.push([`./real/${name}`,1000+i], [`./link/${name}`,1000+i]);
   }
   fs.symlinkSync(process.platform === 'win32' ? path.join(base, 'ctx/real') : 'real', path.join(base, 'ctx/link'), process.platform === 'win32' ? 'junction' : 'dir');
   assert.equal(fs.realpathSync(path.join(base,'ctx/link')), fs.realpathSync(path.join(base,'ctx/real')));
  }
  entries.sort((a,b) => a[0]<b[0] ? -1 : a[0]>b[0] ? 1 : 0);
  write(base, 'index.js', 'const c = require.context("./ctx", true, /\\.js$/); module.exports = {value: require("./ctx/target.js"), count: c.keys().length, entries: c.keys().sort().map(k => [k, c(k)])};\n');
 }
 const targetKey = scenario === 'modules' ? `./${target}` : './target.js';
 const probeSets = [];
 for(let rep=1;rep<=5;rep++) {
  const seed = (0x59c0ffee ^ Math.imul(rep,0x9e3779b9)) >>> 0;
  let state=seed;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  const indices=new Set();
  while(indices.size<10) indices.add(scenario==='modules' ? 1+random()%1999 : random()%20000);
  const files=[...indices].map(index=>{
   if(scenario==='modules') {const [key,value]=entries[index];return {file:key.slice(2),key,initialValue:value,changedValue:value+1000000};}
   const folder=`d${String(index).padStart(5,'0')}`;
   return {file:`ctx/${folder}/probe.js`,key:`./${folder}/probe.js`,initialValue:0,changedValue:1};
  });
  probeSets.push({rep,seed,files});
 }
 const manifest = {scenario, target, targetKey, folders, fillerFiles, moduleCount: entries.length, symlinkFiles: scenario === 'symlink' ? 500 : 0, entries, probeSets};
 fs.writeFileSync(path.join(base,'fixture.json'), JSON.stringify(manifest));
 console.log(JSON.stringify({kind:'fixture',...manifest,entries:undefined,root:fs.realpathSync(base)}));
}
