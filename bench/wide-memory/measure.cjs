'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve('.bench-wide'), results=path.join(root,'results');
fs.mkdirSync(results,{recursive:true});
const script=path.resolve('bench/wide-memory/sample.cjs');
const run=(args,log,env={})=>{
 const fd=fs.openSync(path.join(results,log),'wx');
 let r;
 try {r=spawnSync(process.execPath,args,{env:{...process.env,...env},stdio:['ignore',fd,fd],timeout:660000});}
 finally{fs.closeSync(fd);}
 return r;
};
let result=run([script,'main','wide','1','identity-only'],'identity-positive.log');
assert.equal(result.status,0,'positive binding control');
result=run([script,'main','wide','1','identity-only'],'identity-negative.log',{BENCH_EXPECTED_SHA256:'0'.repeat(64)});
assert.notEqual(result.status,0,'wrong-binding process accepted');
assert.match(fs.readFileSync(path.join(results,'identity-negative.log'),'utf8'),/WRONG_BINDING_HASH/);
console.log('WRONG_BINDING_CONTROL_REJECTED');
result=run([script,'main','modules','1','observer-negative'],'observer-negative.log');
assert.notEqual(result.status,0,'observer in the probe gap accepted');
assert.match(fs.readFileSync(path.join(results,'observer-negative.log'),'utf8'),/OBSERVER_IN_PROBE_GAP/);
console.log('OBSERVER_GAP_CONTROL_REJECTED');
result=run([script,'main','modules','1','retained-stats-negative'],'metadata-negative.log');
assert.notEqual(result.status,0,'retained initial Stats accepted');
assert.match(fs.readFileSync(path.join(results,'metadata-negative.log'),'utf8'),/INITIAL_METADATA_RETAINED_OBJECT/);
console.log('INITIAL_METADATA_CONTROL_REJECTED');
const schedule=[],failures=[];
outer:for(const scenario of ['wide','modules','symlink'])for(let rep=1;rep<=5;rep++) {
 const arms=rep%2?['main','before','fix','wp']:['wp','fix','before','main'];
 for(const arm of arms) {
  if(Date.now()>=Date.parse('2026-10-31T03:45:00Z')){failures.push({kind:'hard-stop-guard'});break outer;}
  const entry={scenario,rep,arm,started:new Date().toISOString()};
  console.log(JSON.stringify({kind:'start-sample',...entry}));
  result=run([script,arm,scenario,String(rep)],`${scenario}-${arm}-${rep}.log`);
  entry.completed=new Date().toISOString();entry.exitCode=result.status;entry.signal=result.signal;
  if(result.error)entry.error=String(result.error);
  schedule.push(entry);
  fs.writeFileSync(path.join(results,'schedule.json'),JSON.stringify(schedule,null,2)+'\n');
  if(result.status!==0)failures.push(entry);
  console.log(JSON.stringify({kind:'end-sample',...entry}));
 }
}
fs.writeFileSync(path.join(results,'failures.json'),JSON.stringify(failures,null,2)+'\n');
const audited=spawnSync(process.execPath,[path.resolve('bench/wide-memory/audit.cjs')],{stdio:'inherit'});
if(failures.length||audited.status!==0)process.exitCode=1;
