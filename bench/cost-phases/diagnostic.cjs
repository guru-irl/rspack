'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const results=path.resolve('.bench-wide/results'),rows=[];
for(const scenario of ['modules','symlink'])for(let rep=1;rep<=3;rep++) {
 const arms=rep%2?['before','fix']:['fix','before'];
 for(const arm of arms)for(const variant of arm==='fix'?['original','ordered','pruned']:['original']) {
  assert(Date.now()<Date.parse('2026-10-31T07:40:00Z'));
  const ordered=variant!=='original',pruned=variant==='pruned';
  const env={...process.env,RSPACK_WATCH_DIAGNOSTICS:'1'};
  if(ordered)env.RSPACK_WATCH_DIAGNOSTICS_ORDER='1';else delete env.RSPACK_WATCH_DIAGNOSTICS_ORDER;
  if(pruned)env.RSPACK_WATCH_DIAGNOSTICS_PRUNE='1';else delete env.RSPACK_WATCH_DIAGNOSTICS_PRUNE;
  const name=`diagnostic-${scenario}-${arm}-${rep}-${variant}`,sample=path.join(results,`${scenario}-${arm}-${rep}.json`);
  assert(!fs.existsSync(sample));
  const fd=fs.openSync(path.join(results,`${name}.log`),'wx');let run;
  try{run=spawnSync(process.execPath,['bench/wide-memory/sample.cjs',arm,scenario,String(rep)],{env,stdio:['ignore',fd,fd],timeout:660000});}finally{fs.closeSync(fd);}
  assert.equal(run.status,0,`diagnostic failed: ${name}`);
  fs.renameSync(sample,path.join(results,`${name}.json`));
  const receipt=JSON.parse(fs.readFileSync(path.join(results,`${name}.json`),'utf8'));
  const text=fs.readFileSync(path.join(results,`${name}.log`),'utf8');
  const events=text.split('\n').filter(l=>l.startsWith('WATCH_DIAG ')).map(l=>JSON.parse(l.slice(11)));
  const close=events.filter(e=>e.phase==='close').at(-1);assert(close);
  const coverage=[...text.matchAll(/WATCH_COVERAGE covered=(\d+) uncoveredAfterRoot=(\d+)/g)].at(-1);assert(coverage);
  const context=[...text.matchAll(/WATCH_CONTEXT count=(\d+) ns=(\d+)/g)].at(-1);assert(context);
  const phases=[...text.matchAll(/WATCH_PHASE (\w+) ns=(\d+)/g)].map(m=>({phase:m[1],ns:Number(m[2])}));
  const firstPhases={};for(const p of phases)if(!(p.phase in firstPhases))firstPhases[p.phase]=p.ns/1000000;
  const totals={};for(const p of phases)totals[p.phase]=(totals[p.phase]||0)+p.ns/1000000;
  const row={scenario,arm,rep,variant,ordered,pruned,readinessMs:receipt.readinessMs,firstDoneMs:receipt.firstDoneMs,fullPeakMiB:receipt.fullPeakMiB,idleRssMiB:receipt.idleRssMiB,watchesIdle:receipt.watchesIdle,identity:receipt.identity,close,coverage:{covered:Number(coverage[1]),uncoveredAfterRoot:Number(coverage[2])},context:{count:Number(context[1]),ms:Number(context[2])/1000000},firstPhases,phaseTotals:totals};
  rows.push(row);fs.writeFileSync(path.join(results,'diagnosis.json'),JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify(row));
 }
}
