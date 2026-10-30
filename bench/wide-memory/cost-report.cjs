'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]||'.bench-wide/collected'),out=path.resolve('.bench-wide/report');
fs.mkdirSync(out,{recursive:true});
const median=values=>{assert(values.length);const a=[...values].sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
function estimate(values){
 assert.equal(values.length,5,'five paired samples required');assert(values.every(Number.isFinite));
 let seed=0x59434f53;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
 const boot=Array.from({length:20000},()=>median(Array.from({length:5},()=>values[Math.floor(random()*5)]))).sort((a,b)=>a-b);
 return{median:median(values),low:boot[500],high:boot[19499],values};
}
assert.deepEqual(estimate([3,3,3,3,3]),{median:3,low:3,high:3,values:[3,3,3,3,3]});
assert.throws(()=>estimate([1,2,3,4]));assert.throws(()=>estimate([1,2,3,4,NaN]));
const format=n=>n===null?'not exposed':n.toFixed(2),signed=n=>`${n>=0?'+':''}${n.toFixed(2)}`;
const interval=s=>`${signed(s.median)} [${signed(s.low)}, ${signed(s.high)}]`;
const systems=['macOS','Windows','Linux'],scenarios=['wide','modules','symlink'],arms=['cost','fix','before','wp'];
const metrics=['readinessMs','firstProbeMs','firstDoneMs','fullPeakMiB','readinessPeakMiB','idleRssMiB','editedRssMiB','firstDoneToProbeWriteMs','watchesIdle.count'];
const value=(row,key)=>key.split('.').reduce((v,k)=>v[k],row);
const data={},identities={},flags=[];
let report='# PR59 watcher startup cost measurements\n\nFive alternating paired rounds. Brackets are 95% percentile bootstrap intervals for paired medians.\n\n';
for(const os of systems){
 const folder=path.join(root,`wide-results-${os}`),summary=JSON.parse(fs.readFileSync(path.join(folder,'summary.json'),'utf8'));
 assert.equal(summary.platform,os);assert.equal(summary.complete,true);assert.equal(summary.sampleCount,60);assert.equal(summary.controls.length,8);
 for(const [file,marker] of [['identity-negative.log','WRONG_BINDING_HASH'],['observer-negative.log','OBSERVER_IN_PROBE_GAP'],['metadata-negative.log','INITIAL_METADATA_RETAINED_OBJECT']])assert(fs.readFileSync(path.join(folder,file),'utf8').includes(marker));
 data[os]={};identities[os]=summary.identities;
 report+=`## ${os}\n\n| Scenario / metric | Cost fix | 90f41a8a | b87c553c | Watchpack | Vs 90f41a8a | Vs b87c553c | Vs Watchpack |\n|---|---:|---:|---:|---:|---|---|---|\n`;
 for(const scenario of scenarios){
  const rows=Object.fromEntries(arms.map(arm=>[arm,Array.from({length:5},(_,i)=>JSON.parse(fs.readFileSync(path.join(folder,`${scenario}-${arm}-${i+1}.json`),'utf8')))]));
  data[os][scenario]={};
  for(const key of metrics){
   const values=Object.fromEntries(arms.map(arm=>[arm,rows[arm].map(r=>value(r,key))]));
   const medians=Object.fromEntries(arms.map(arm=>[arm,values[arm].every(v=>v!==null)?median(values[arm]):null]));
   const pairs={};for(const base of ['fix','before','wp']){
    pairs[base]=medians.cost===null||medians[base]===null?null:{delta:estimate(values.cost.map((v,i)=>v-values[base][i])),percent:estimate(values.cost.map((v,i)=>(v/values[base][i]-1)*100))};
   }
   data[os][scenario][key]={medians,pairs};
   if(['readinessMs','fullPeakMiB'].includes(key)){
    const cells=['fix','before','wp'].map(base=>`${interval(pairs[base].delta)}; ${interval(pairs[base].percent)}%`);
    report+=`| ${scenario} / ${key==='readinessMs'?'readiness ms':'peak MiB'} | ${arms.map(arm=>format(medians[arm])).join(' | ')} | ${cells.join(' | ')} |\n`;
    if(pairs.before.percent.median>(key==='readinessMs'?20:10))flags.push({os,scenario,key,...pairs.before});
   }
  }
 }
 report+='\n| Scenario / arm | First done ms | First probe ms | Idle MiB | After edits MiB | Native watches |\n|---|---:|---:|---:|---:|---:|\n';
 for(const scenario of scenarios)for(const arm of arms)report+=`| ${scenario} / ${arm} | ${['firstDoneMs','firstProbeMs','idleRssMiB','editedRssMiB','watchesIdle.count'].map(key=>format(data[os][scenario][key].medians[arm])).join(' | ')} |\n`;
 report+='\n';
}
fs.writeFileSync(path.join(out,'cost-measurements.json'),JSON.stringify({data,identities,flags},null,2)+'\n');
fs.writeFileSync(path.join(out,'cost-measurements.md'),report);
console.log(report);console.log(JSON.stringify({kind:'target-flags',flags}));
