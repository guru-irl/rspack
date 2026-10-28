'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
assert.equal(process.platform, 'win32');
const root = path.resolve(process.argv[2]), rows = [];
function walk(dir) { for(const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,e.name); if(e.isDirectory()) walk(p); else if(/^(base|final)-memory-[1-5]\.json$/.test(e.name)) rows.push(JSON.parse(fs.readFileSync(p,'utf8'))); } }
walk(root); assert.equal(rows.length,110);
function median(a) { a=[...a].sort((a,b)=>a-b); assert.equal(a.length,5); return a[2]; }
const groups = new Map();
for(const r of rows) { const key=`${r.files}/${r.contexts}/${r.applications}/${r.allocatorPolicy || 'matrix'}`; if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(r); }
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
  const ordered = arm => samples.filter(r=>r.arm===arm).sort((a,b)=>a.rep-b.rep).map(r=>r.snapshots.find(s=>s.phase===phase));
  const b=ordered('base'),h=ordered('final');
  row.pairedDelta={privateMiB:median(h.map((s,i)=>(s.privateBytes-b[i].privateBytes)/2**20)),heapPhysicalMiB:median(h.map((s,i)=>(s.v8.total_physical_size-b[i].v8.total_physical_size)/2**20)),heapUsedMiB:median(h.map((s,i)=>(s.node.heapUsed-b[i].node.heapUsed)/2**20)),nonV8PrivateMiB:median(h.map((s,i)=>(s.privateBytes-b[i].privateBytes-s.v8.total_physical_size+b[i].v8.total_physical_size)/2**20))};
  if(phase==='steady' && configuration.startsWith('80000/3000/4/')) row.pairs=h.map((s,i)=>({rep:i+1,privateMiB:(s.privateBytes-b[i].privateBytes)/2**20,heapPhysicalMiB:(s.v8.total_physical_size-b[i].v8.total_physical_size)/2**20,nonV8PrivateMiB:(s.privateBytes-b[i].privateBytes-s.v8.total_physical_size+b[i].v8.total_physical_size)/2**20}));
  result.push(row);
  console.log(JSON.stringify(row));
 }
 console.log(`INSPECTION_END ${configuration}`);
}
fs.writeFileSync(path.join(root,'inspection.json'),JSON.stringify(result,null,2)+'\n');
