'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve('.bench-wide'),original=path.join(root,'original'),results=path.join(root,'results');
assert.equal(process.platform,'darwin');
const host=JSON.parse(fs.readFileSync(path.join(results,'host.json'),'utf8'));
for(const name of fs.readdirSync(original)){
 const dest=path.join(results,name);
 if(name==='summary.json'||name==='summary.md'||fs.existsSync(dest))fs.copyFileSync(path.join(original,name),path.join(results,`prior-${name}`));
 else fs.copyFileSync(path.join(original,name),dest);
}
const receipt=JSON.parse(fs.readFileSync(path.join(results,'retry-receipt.json'),'utf8'));
receipt.extraSeries={run:process.env.GITHUB_RUN_ID,prior:41157424635,host};receipt.expectedReps={wide:5,modules:5,symlink:10};
const schedule=[],failures=[],digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function describe(f,log,attempt){
 const text=fs.readFileSync(log,'utf8'),spec=JSON.parse(fs.readFileSync(path.join(root,'fixtures','symlink','fixture.json'),'utf8')),probes=spec.probeSets[f.rep-1];
 const row={platform:'darwin',arm:f.arm,scenario:'symlink',rep:f.rep,seed:probes.seed,attempt,log:path.basename(log)},probe=text.split('\n').find(l=>l.startsWith('PROBE_EXPORT_DIAGNOSTIC '));
 if(probe){const d=JSON.parse(probe.slice('PROBE_EXPORT_DIAGNOSTIC '.length));row.phase='readiness';row.editNumber=null;row.read=d.actualBundleValue;}
 else {row.editNumber=Number(text.match(/stale output at version (\d+)/)?.[1])||null;row.phase='edits';row.read='not logged';row.actualHash=text.match(/actual: '([0-9a-f]{64})'/)?.[1];row.expectedHash=text.match(/expected: '([0-9a-f]{64})'/)?.[1];
  if(row.editNumber&&row.actualHash){const values=new Map(probes.files.map(p=>[p.key,p.changedValue])),entries=[...spec.entries,...probes.files.map(p=>[p.key,p.initialValue])].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
   const output=value=>({value,count:entries.length,entries:entries.map(([key,initial])=>[key,key===spec.targetKey?value:values.has(key)?values.get(key):initial])});assert.equal(digest(output(row.editNumber)),row.expectedHash);
   for(const candidate of [{},...Array.from({length:21},(_,i)=>i)])if(digest(output(candidate))===row.actualHash){row.read=JSON.stringify(candidate);row.readProof='full emitted-output hash match';break;}
  }
 }
 return row;
}
function run(arm,rep,replacement=false){
 assert(Date.now()<Date.parse('2026-10-31T07:40:00Z'));assert(!fs.existsSync(path.join(results,`symlink-${arm}-${rep}.json`)));
 const log=path.join(results,`symlink-${arm}-${rep}${replacement?'-replacement':''}.log`),fd=fs.openSync(log,'wx');let child;
 const started=new Date().toISOString();try{child=spawnSync(process.execPath,['bench/wide-memory/sample.cjs',arm,'symlink',String(rep)],{env:process.env,stdio:['ignore',fd,fd],timeout:660000});}finally{fs.closeSync(fd);}
 const f={arm,scenario:'symlink',rep,started,completed:new Date().toISOString(),exitCode:child.status,signal:child.signal};schedule.push(f);
 if(child.status!==0)receipt.failureDetails.push(describe(f,log,replacement?2:1));
 return f;
}
for(let rep=6;rep<=10;rep++)for(const arm of(rep%2?['before','fix','cost','wp']:['wp','cost','fix','before'])){const f=run(arm,rep);if(f.exitCode!==0){failures.push(f);receipt.firstFailures.push(f);}}
for(const f of failures)if(f.arm==='wp'){
 const next=run('wp',f.rep,true),seed=receipt.failureDetails.find(d=>d.arm==='wp'&&d.rep===f.rep).seed;
 receipt.replacements.push({...next,seed,log:`symlink-wp-${f.rep}-replacement.log`});
 if(next.exitCode!==0)receipt.missingWatchpack.push({scenario:'symlink',rep:f.rep,seed,reason:`Watchpack failed twice on seed ${seed}`});
}
receipt.failureCounts=Object.fromEntries(['cost','fix','before','wp'].map(arm=>[arm,receipt.failureDetails.filter(d=>d.arm===arm).length]));
fs.writeFileSync(path.join(results,'retry-receipt.json'),JSON.stringify(receipt,null,2)+'\n');fs.writeFileSync(path.join(results,'extra-schedule.json'),JSON.stringify(schedule,null,2)+'\n');
const audit=spawnSync(process.execPath,['bench/wide-memory/audit.cjs'],{env:process.env,stdio:'inherit'});assert.equal(audit.status,0,'extra-series decision samples incomplete');
