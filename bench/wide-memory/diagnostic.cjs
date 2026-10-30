'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const results=path.resolve('.bench-wide/results'),rows=[];
for(const scenario of ['modules','symlink'])for(let rep=1;rep<=3;rep++) {
  const arms=rep%2?['before','fix']:['fix','before'];
  for(const arm of arms)for(const ordered of arm==='fix'?[false,true]:[false]) {
    assert(Date.now()<Date.parse('2026-10-31T07:40:00Z'));
    const env={...process.env,RSPACK_WATCH_DIAGNOSTICS:'1'};
    if(ordered)env.RSPACK_WATCH_DIAGNOSTICS_ORDER='1';
    else delete env.RSPACK_WATCH_DIAGNOSTICS_ORDER;
    const name=`diagnostic-${scenario}-${arm}-${rep}-${ordered?'ordered':'original'}`;
    const sample=path.join(results,`${scenario}-${arm}-${rep}.json`);
    assert(!fs.existsSync(sample));
    const fd=fs.openSync(path.join(results,`${name}.log`),'wx');
    let run;
    try {run=spawnSync(process.execPath,['bench/wide-memory/sample.cjs',arm,scenario,String(rep)],{env,stdio:['ignore',fd,fd],timeout:660000});}
    finally {fs.closeSync(fd);}
    assert.equal(run.status,0,`diagnostic failed: ${name}`);
    fs.renameSync(sample,path.join(results,`${name}.json`));
    const receipt=JSON.parse(fs.readFileSync(path.join(results,`${name}.json`),'utf8'));
    const events=fs.readFileSync(path.join(results,`${name}.log`),'utf8').split('\n').filter(l=>l.startsWith('WATCH_DIAG ')).map(l=>JSON.parse(l.slice(11)));
    assert(events.length>0,`missing diagnostics: ${name}`);
    const close=events.filter(e=>e.phase==='close').at(-1);assert(close);
    const row={scenario,arm,rep,ordered,readinessMs:receipt.readinessMs,firstDoneMs:receipt.firstDoneMs,fullPeakMiB:receipt.fullPeakMiB,idleRssMiB:receipt.idleRssMiB,identity:receipt.identity,close,firstWatch:events.find(e=>e.phase==='watch')};
    rows.push(row);fs.writeFileSync(path.join(results,'diagnosis.json'),JSON.stringify(rows,null,2)+'\n');
    console.log(JSON.stringify(row));
  }
}
