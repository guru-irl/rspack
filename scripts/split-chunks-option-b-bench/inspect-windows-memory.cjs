'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
assert.equal(process.platform, 'win32');
const root = path.resolve(process.argv[2]), rows = [];
function walk(dir) { for(const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,e.name); if(e.isDirectory()) walk(p); else if(/^(base|final)-memory-[1-5]\.json$/.test(e.name)) rows.push(JSON.parse(fs.readFileSync(p,'utf8'))); } }
walk(root); assert.equal(rows.length,80);
function median(a) { a=[...a].sort((a,b)=>a-b); assert.equal(a.length,5); return a[2]; }
const groups = new Map();
for(const r of rows) { const key=`${r.files}/${r.contexts}/${r.applications}`; if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(r); }
const result = [];
for(const [configuration, samples] of groups) {
 assert.equal(samples.length,10);
 console.log(`INSPECTION_BEGIN ${configuration}`);
 for(const phase of ['initial-applied','steady','steady-idle-10s','closed-references-held','dropped','dropped-idle-10s']) {
  const row = {configuration,phase};
  for(const arm of ['base','final']) {
   const snaps=samples.filter(r=>r.arm===arm).map(r=>r.snapshots.find(s=>s.phase===phase));
   row[arm]={privateMiB:median(snaps.map(s=>s.privateBytes/2**20)),threads:median(snaps.map(s=>s.threads)),handles:median(snaps.map(s=>s.handles)),heapUsedMiB:median(snaps.map(s=>s.node.heapUsed/2**20)),heapTotalMiB:median(snaps.map(s=>s.node.heapTotal/2**20)),heapPhysicalMiB:median(snaps.map(s=>s.v8.total_physical_size/2**20)),externalMiB:median(snaps.map(s=>s.node.external/2**20)),mallocedMiB:median(snaps.map(s=>s.v8.malloced_memory/2**20)),elapsedSeconds:median(snaps.map(s=>s.elapsedMs/1000))};
  }
  result.push(row);
  console.log(JSON.stringify(row));
 }
 console.log(`INSPECTION_END ${configuration}`);
}
fs.writeFileSync(path.join(root,'inspection.json'),JSON.stringify(result,null,2)+'\n');
