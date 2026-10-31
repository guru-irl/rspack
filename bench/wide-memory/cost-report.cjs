'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]||'.bench-wide/collected'),out=path.resolve('.bench-wide/report');
fs.mkdirSync(out,{recursive:true});
const median=values=>{assert(values.length);const a=[...values].sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
function estimate(values){
 assert(values.length===5||values.length===10,'five or ten paired samples required');assert(values.every(Number.isFinite));
 let seed=0x59434f53;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
 const boot=Array.from({length:20000},()=>median(Array.from({length:values.length},()=>values[Math.floor(random()*values.length)]))).sort((a,b)=>a-b);
 return{median:median(values),low:boot[500],high:boot[19499],values};
}
assert.deepEqual(estimate([3,3,3,3,3]),{median:3,low:3,high:3,values:[3,3,3,3,3]});
assert.throws(()=>estimate([1,2,3,4]));assert.throws(()=>estimate([1,2,3,4,NaN]));
const format=n=>n===null?'not exposed':n.toFixed(2),signed=n=>`${n>=0?'+':''}${n.toFixed(2)}`;
const interval=s=>`${signed(s.median)} [${signed(s.low)}, ${signed(s.high)}]`;
const systems=['macOS','Windows','Linux'],scenarios=['wide','modules','symlink'],arms=['cost','fix','before','wp'];
const metrics=['readinessMs','firstProbeMs','firstDoneMs','fullPeakMiB','readinessPeakMiB','idleRssMiB','editedRssMiB','firstDoneToProbeWriteMs','watchesIdle.count'];
const value=(row,key)=>key.split('.').reduce((v,k)=>v[k],row);
const data={},identities={},flags=[],harnessFailures=[],failureCounts={cost:0,fix:0,before:0,wp:0};
let report='# PR59 watcher startup cost measurements\n\nFive alternating paired rounds, ten for macOS symlink. Brackets are 95% percentile bootstrap intervals for paired medians.\n\n';
for(const os of systems){
 const folder=path.join(root,`wide-results-${os}`),summary=JSON.parse(fs.readFileSync(path.join(folder,'summary.json'),'utf8'));
 const expectedReps=summary.expectedReps||{wide:5,modules:5,symlink:5};
 assert.equal(summary.platform,os);assert.equal(summary.complete,true);assert.equal(summary.decisionComplete,true);assert.equal(summary.sampleCount,4*scenarios.reduce((n,s)=>n+expectedReps[s],0)-summary.missingWatchpack.length);assert.equal(summary.controls.length,8);
 for(const [arm,count] of Object.entries(summary.failureCounts))failureCounts[arm]+=count;
 for(const failure of summary.failureDetails)harnessFailures.push({os,...failure});
 for(const [file,marker] of [['identity-negative.log','WRONG_BINDING_HASH'],['observer-negative.log','OBSERVER_IN_PROBE_GAP'],['metadata-negative.log','INITIAL_METADATA_RETAINED_OBJECT']])assert(fs.readFileSync(path.join(folder,file),'utf8').includes(marker));
 data[os]={};identities[os]=summary.identities;
 report+=`## ${os}\n\n| Scenario / metric | Cost fix | 90f41a8a | b87c553c | Watchpack | Vs 90f41a8a | Vs b87c553c | Vs Watchpack |\n|---|---:|---:|---:|---:|---|---|---|\n`;
 for(const scenario of scenarios){
  const rows=Object.fromEntries(arms.map(arm=>[arm,Array.from({length:expectedReps[scenario]},(_,i)=>{
   const file=path.join(folder,`${scenario}-${arm}-${i+1}.json`);
   if(!fs.existsSync(file)){assert(arm==='wp'&&summary.missingWatchpack.some(c=>c.scenario===scenario&&c.rep===i+1));return null;}
   return JSON.parse(fs.readFileSync(file,'utf8'));
  }).filter(Boolean)]));
  data[os][scenario]={};
  for(const key of metrics){
   const values=Object.fromEntries(arms.map(arm=>[arm,rows[arm].map(r=>value(r,key))]));
   const medians=Object.fromEntries(arms.map(arm=>[arm,values[arm].length===expectedReps[scenario]&&values[arm].every(v=>v!==null)?median(values[arm]):null]));
   const pairs={};for(const base of ['fix','before','wp']){
    pairs[base]=medians.cost===null||medians[base]===null?null:{delta:estimate(values.cost.map((v,i)=>v-values[base][i])),percent:estimate(values.cost.map((v,i)=>(v/values[base][i]-1)*100))};
   }
   data[os][scenario][key]={medians,pairs};
   if(['readinessMs','fullPeakMiB'].includes(key)){
    const missingLabel=summary.missingWatchpack.filter(c=>c.scenario===scenario).map(c=>c.reason).join('; ');
    const cells=['fix','before','wp'].map(base=>pairs[base]?`${interval(pairs[base].delta)}; ${interval(pairs[base].percent)}%`:missingLabel||'not exposed');
    report+=`| ${scenario} / ${key==='readinessMs'?'readiness ms':'peak MiB'} | ${arms.map(arm=>arm==='wp'&&rows.wp.length<expectedReps[scenario]?missingLabel:format(medians[arm])).join(' | ')} | ${cells.join(' | ')} |\n`;
    if(pairs.before.percent.median>(key==='readinessMs'?20:10))flags.push({os,scenario,key,...pairs.before});
   }
  }
 }
 report+='\n| Scenario / arm | First done ms | First probe ms | Idle MiB | After edits MiB | Native watches |\n|---|---:|---:|---:|---:|---:|\n';
 for(const scenario of scenarios)for(const arm of arms)report+=`| ${scenario} / ${arm} | ${['firstDoneMs','firstProbeMs','idleRssMiB','editedRssMiB','watchesIdle.count'].map(key=>format(data[os][scenario][key].medians[arm])).join(' | ')} |\n`;
 report+='\n';
}
report+='## Harness failures\n\n| OS | Arm | Scenario | Seed | Attempt | Edit | Read |\n|---|---|---|---:|---:|---|---|\n';
for(const f of harnessFailures)report+=`| ${f.os} | ${f.arm} | ${f.scenario} | ${f.seed} | ${f.attempt} | ${f.editNumber??'readiness probes'} | ${f.read}${f.readProof?' by output hash':''} |\n`;
report+=`\nFailed measurement processes by arm: candidate ${failureCounts.cost}, 90f41a8a ${failureCounts.fix}, b87c553c ${failureCounts.before}, Watchpack ${failureCounts.wp}. Negative controls are not samples.\n`;
fs.writeFileSync(path.join(out,'cost-measurements.json'),JSON.stringify({data,identities,flags,harnessFailures,failureCounts},null,2)+'\n');
fs.writeFileSync(path.join(out,'cost-measurements.md'),report);
console.log(report);console.log(JSON.stringify({kind:'target-flags',flags}));
