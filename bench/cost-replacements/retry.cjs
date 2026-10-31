'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve('.bench-wide'),original=path.join(root,'original'),results=path.join(root,'results');
const failures=JSON.parse(fs.readFileSync(path.join(original,'failures.json'),'utf8'));
const currentHost=JSON.parse(fs.readFileSync(path.join(results,'host.json'),'utf8'));
for(const name of fs.readdirSync(original)) {
 const dest=path.join(results,name);
 if(name==='host.json'||name==='summary.json'||name==='summary.md'||name==='schedule.json'||name==='failures.json')fs.copyFileSync(path.join(original,name),path.join(results,`original-${name}`));
 else if(fs.existsSync(dest)){
  if(/^identity-/.test(name))assert(fs.readFileSync(dest).equals(fs.readFileSync(path.join(original,name))),`conflicting binding identity: ${name}`);
  fs.copyFileSync(path.join(original,name),path.join(results,`original-${name}`));
 }else fs.copyFileSync(path.join(original,name),dest);
}
const receipt={producer:41149287712,run:process.env.GITHUB_RUN_ID,currentHost,firstFailures:failures,replacements:[],missingWatchpack:[],failureDetails:[]};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function describe(failure,logFile,attempt) {
 const text=fs.readFileSync(logFile,'utf8'),spec=JSON.parse(fs.readFileSync(path.join(root,'fixtures',failure.scenario,'fixture.json'),'utf8'));
 const probes=spec.probeSets[failure.rep-1],line=text.split('\n').find(l=>l.startsWith('PROBE_EXPORT_DIAGNOSTIC '));
 const row={platform:currentHost.platform,arm:failure.arm,scenario:failure.scenario,rep:failure.rep,seed:probes.seed,attempt,log:path.basename(logFile)};
 if(line){const d=JSON.parse(line.slice('PROBE_EXPORT_DIAGNOSTIC '.length));row.phase='readiness';row.editNumber=null;row.read=d.actualBundleValue;row.expected=d.expectedProbeValue;row.probe=d.probeFile;}
 else {
  row.editNumber=Number(text.match(/stale output at version (\d+)/)?.[1])||null;row.phase=row.editNumber?'edits':'unknown';row.read='not logged';
  row.actualHash=text.match(/actual: '([0-9a-f]{64})'/)?.[1];row.expectedHash=text.match(/expected: '([0-9a-f]{64})'/)?.[1];
  if(row.editNumber&&row.actualHash){
   const values=new Map(probes.files.map(p=>[p.key,p.changedValue]));
   const entries=(failure.scenario==='modules'?spec.entries:[...spec.entries,...probes.files.map(p=>[p.key,p.initialValue])]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
   const output=value=>({value,count:entries.length,entries:entries.map(([key,initial])=>[key,key===spec.targetKey?value:values.has(key)?values.get(key):initial])});
   assert.equal(digest(output(row.editNumber)),row.expectedHash,'failure decoder expected hash');
   for(const candidate of [{},...Array.from({length:21},(_,i)=>i)])if(digest(output(candidate))===row.actualHash){row.read=JSON.stringify(candidate);row.readProof='full emitted-output hash match';break;}
  }
 }
 return row;
}
const seen=new Set();
for(const failure of failures){
 assert.equal(failure.arm,'wp','a deciding native arm failed; replacement not authorized');
 const key=`${failure.scenario}/${failure.arm}/${failure.rep}`;assert(!seen.has(key));seen.add(key);
 assert(Date.now()<Date.parse('2026-10-31T07:40:00Z'));
 const target=path.join(results,`${failure.scenario}-wp-${failure.rep}.json`);assert(!fs.existsSync(target));
 const oldLog=path.join(original,`${failure.scenario}-wp-${failure.rep}.log`);
 receipt.failureDetails.push(describe(failure,oldLog,1));
 const log=path.join(results,`${failure.scenario}-wp-${failure.rep}-replacement.log`),fd=fs.openSync(log,'wx');let run;
 try {run=spawnSync(process.execPath,['bench/wide-memory/sample.cjs','wp',failure.scenario,String(failure.rep)],{env:process.env,stdio:['ignore',fd,fd],timeout:660000});}finally{fs.closeSync(fd);}
 receipt.replacements.push({arm:'wp',scenario:failure.scenario,rep:failure.rep,seed:receipt.failureDetails.at(-1).seed,exitCode:run.status,signal:run.signal,log:path.basename(log)});
 if(run.status!==0){
  receipt.failureDetails.push(describe(failure,log,2));
  receipt.missingWatchpack.push({scenario:failure.scenario,rep:failure.rep,seed:receipt.failureDetails.at(-1).seed,reason:`Watchpack failed twice on seed ${receipt.failureDetails.at(-1).seed}`});
 }
 fs.writeFileSync(path.join(results,'retry-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
}
receipt.failureCounts={cost:0,fix:0,before:0,wp:receipt.failureDetails.length};
fs.writeFileSync(path.join(results,'retry-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
const audited=spawnSync(process.execPath,['bench/wide-memory/audit.cjs'],{env:process.env,stdio:'inherit'});
assert.equal(audited.status,0,'decision samples or receipt controls failed');
