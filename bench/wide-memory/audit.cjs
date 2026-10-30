'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve('.bench-wide'),results=path.join(root,'results');
const arms=['main','before','fix','wp'],scenarios=['wide','modules','symlink'];
const refs={main:'79c650c24e4b468e743ebfe6454b3b2bc6650938',before:'b87c553ce76f2055d2ee19de589f5bbc106ff23d',fix:'90f41a8ac8200533cdc96aa31b4b818bf8a75561',wp:'79c650c24e4b468e743ebfe6454b3b2bc6650938'};
const median=xs=>{if(!xs.length)return null;const a=[...xs].sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const specs=Object.fromEntries(scenarios.map(s=>[s,JSON.parse(fs.readFileSync(path.join(root,'fixtures',s,'fixture.json'),'utf8'))]));
function expectedHash(scenario,rep,version,changed) {
 const s=specs[scenario],probes=s.probeSets[rep-1].files;
 if(changed===undefined)changed=probes.map(p=>p.key);
 const keys=new Set(changed),values=new Map(probes.filter(p=>keys.has(p.key)).map(p=>[p.key,p.changedValue]));
 const entries=(scenario==='modules'?s.entries:[...s.entries,...probes.map(p=>[p.key,p.initialValue])]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
 return digest({value:version,count:entries.length,entries:entries.map(([key,value])=>[key,key===s.targetKey?version:values.has(key)?values.get(key):value])});
}
const platform={linux:'Linux',darwin:'macOS',win32:'Windows'}[process.platform];
const pins=Object.fromEntries(['main','before','fix'].map(arm=>[arm,JSON.parse(fs.readFileSync(path.join(root,'bindings',`wide-binding-${platform}-${arm}`,'identity.json'),'utf8'))]));
function validate(rows,complete=true) {
 const seen=new Set();
 for(const row of rows) {
  const {arm,scenario,rep}=row,key=`${scenario}/${arm}/${rep}`;
  assert(arms.includes(arm)&&scenarios.includes(scenario)&&Number.isInteger(rep)&&rep>=1&&rep<=5,'unexpected sample');
  assert(!seen.has(key),'duplicate sample');seen.add(key);assert.equal(row.platform,platform);
  assert.equal(row.identity.source,refs[arm],'source identity');
  const pin=pins[arm==='wp'?'main':arm];
  assert.equal(row.identity.sha256,pin.sha256,'wrong binding');assert.equal(row.identity.coreIndexHash,pin.coreIndexHash,'wrong JavaScript');
  assert.deepEqual(row.identity.mapped,[row.identity.selected],'mapped path differs from selected file');
  assert.equal(row.identity.report,process.platform==='linux'?'/proc/self/maps':'process.report.sharedObjects');
  assert.equal(row.watchpackVersion,'2.6.3');assert.equal(row.outputParity,true);
  const fixture=specs[scenario],probeSet=fixture.probeSets[rep-1],probes=probeSet.files;
  assert.deepEqual(row.fixture,{folders:fixture.folders,fillerFiles:fixture.fillerFiles,moduleCount:fixture.moduleCount+(scenario==='modules'?0:10),symlinkFiles:fixture.symlinkFiles,probeSeed:probeSet.seed,probeCount:10});
  for(const key of ['firstDoneMs','readinessMs','firstProbeMs','firstDonePeakMiB','readinessPeakMiB','idleRssMiB','editedRssMiB','editLatencyMs','fullPeakMiB'])assert(Number.isFinite(row[key])&&row[key]>0,key);
  assert(row.firstDoneMs<=row.firstProbeMs&&row.firstProbeMs<=row.readinessMs,'phase order');
  assert.equal(row.observerGapGuard,true);
  assert(Number.isFinite(row.firstProbeWriteMs)&&row.firstProbeWriteMs>=row.firstDoneMs&&row.firstProbeWriteMs<=row.firstProbeMs,'probe write order');
  assert.equal(row.firstDoneToProbeWriteMs,row.firstProbeWriteMs-row.firstDoneMs);
  assert.equal(row.probes.length,10,'missing readiness probe');
  assert.deepEqual(row.probes.map(p=>p.file),probes.map(p=>p.file));
  const deliveries=new Map();
  assert(row.probeRebuilds.length>0,'no readiness rebuilds');
  for(const receipt of row.probeRebuilds) {
   assert.equal(receipt.outputMatches,true);assert.equal(receipt.actualHash,expectedHash(scenario,rep,0,receipt.changed),'stale probe output');
   assert.equal(receipt.expectedHash,receipt.actualHash);
   assert(new Set(receipt.changed).size===receipt.changed.length&&receipt.changed.every(k=>probes.some(p=>p.key===k)),'invalid probe assignment');
   for(const p of probes)if(receipt.modifiedFiles.includes(p.file)){
    assert(receipt.changed.includes(p.key),'reported probe has stale output');
    if(!deliveries.has(p.key))deliveries.set(p.key,receipt.elapsedMs);
   }
  }
  for(const probe of row.probes){assert.equal(probe.landedMs,deliveries.get(probe.key),'probe delivery time');assert(Number.isFinite(probe.landedMs)&&Number.isInteger(probe.rewrites)&&probe.rewrites>0);}
  assert.equal(row.firstProbeMs,Math.min(...row.probes.map(p=>p.landedMs)));
  assert.equal(row.readinessMs,Math.max(...row.probes.map(p=>p.landedMs)));
  assert.equal(row.probeRebuilds.at(-1).actualHash,expectedHash(scenario,rep,0),'last probe output');
  if(process.platform==='linux'){
   const counter=JSON.parse(fs.readFileSync(path.join(results,`${scenario}-${arm}-${rep}-inotify.json`),'utf8'));
   assert.equal(counter.intervalMs,200);assert.equal(counter.windowMs,2400);assert.equal(row.inotifyStableMs,counter.stableMs);
   assert(Number.isFinite(counter.stableMs)&&counter.stableMs>=2400,'unstable inotify count');
   let lastChange=0;for(let i=1;i<counter.samples.length;i++)if(counter.samples[i].watches!==counter.samples[i-1].watches)lastChange=i;
   const stable=counter.samples.slice(lastChange).find(s=>s.elapsedMs-counter.samples[lastChange].elapsedMs>=2400);
   assert(stable);assert.equal(counter.stableMs,stable.elapsedMs);assert.equal(counter.stableCount,row.watchesIdle.count);
  }else assert.equal(row.inotifyStableMs,null);
  assert.equal(row.idleSamples.length,5);assert.equal(row.editedSamples.length,5);
  assert.equal(row.idleRssMiB,median(row.idleSamples));assert.equal(row.editedRssMiB,median(row.editedSamples));
  assert.equal(row.edits.length,20,'missing edit');assert.equal(row.initial.outputMatches,true);
  assert.equal(row.initial.actualHash,expectedHash(scenario,rep,0,[]),'initial output');assert.equal(row.initial.expectedHash,row.initial.actualHash);
  row.edits.forEach((edit,index)=>{assert.equal(edit.version,index+1);assert.equal(edit.outputMatches,true);assert.equal(edit.actualHash,expectedHash(scenario,rep,index+1),'stale output');assert.equal(edit.expectedHash,edit.actualHash);assert(Number.isFinite(edit.latencyMs)&&edit.latencyMs>=0);});
  assert.equal(row.editLatencyMs,median(row.edits.map(e=>e.latencyMs)));
  for(const watches of [row.watchesIdle,row.watchesEdited]){if(watches.count!==null)assert(Number.isInteger(watches.count)&&watches.count>0,'watch count');else assert.equal(process.platform,'darwin','native watch count unavailable on a countable platform');}
 }
 if(complete)for(const scenario of scenarios)for(const arm of arms)for(let rep=1;rep<=5;rep++)assert(seen.has(`${scenario}/${arm}/${rep}`),`missing sample ${scenario}/${arm}/${rep}`);
 return true;
}
const rows=fs.readdirSync(results).filter(n=>/^(wide|modules|symlink)-(main|before|fix|wp)-[1-5]\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(results,n),'utf8')));
validate(rows,false);let complete=true;
try{validate(rows,true);}catch(e){complete=false;console.error(e.message);}
const controls=[];
if(complete){
 const reject=(name,change)=>{const copy=structuredClone(rows);change(copy);assert.throws(()=>validate(copy,true),undefined,`${name} accepted`);controls.push({name,rejected:true});};
 reject('missing-sample',copy=>copy.pop());reject('wrong-binding',copy=>copy[0].identity.sha256='0'.repeat(64));
 reject('stale-edited-output',copy=>copy[0].edits[0].actualHash=expectedHash(copy[0].scenario,copy[0].rep,0));
 reject('missing-edit',copy=>copy[0].edits.pop());reject('duplicate-sample',copy=>copy.push(copy[0]));reject('wrong-source',copy=>copy[0].identity.source='x');
 reject('missing-readiness-probe',copy=>copy[0].probes.pop());reject('stale-probe-output',copy=>copy[0].probeRebuilds.at(-1).actualHash=expectedHash(copy[0].scenario,copy[0].rep,0,[]));
 console.log(JSON.stringify({kind:'receipt-controls',controls}));
}
const metrics=[['Readiness, ms','readinessMs'],['First probe, ms','firstProbeMs'],['First done, ms','firstDoneMs'],['First done to first probe write, ms','firstDoneToProbeWriteMs'],['Inotify stable, ms','inotifyStableMs'],['First done peak RSS, MiB','firstDonePeakMiB'],['Readiness peak RSS, MiB','readinessPeakMiB'],['Full-run peak RSS, MiB','fullPeakMiB'],['Idle RSS, MiB','idleRssMiB'],['After 20 edits RSS, MiB','editedRssMiB'],['Edit latency, ms','editLatencyMs'],['Native watches','watchesIdle.count']];
const get=(row,key)=>key.split('.').reduce((value,k)=>value[k],row);
const stats=values=>({median:median(values),min:Math.min(...values),max:Math.max(...values),values});
const data={},large=[];
const format=(value,digits=2)=>value===null?'not exposed':value.toFixed(digits),signed=value=>`${value>=0?'+':''}${value.toFixed(2)}`;
let md=`# ${platform} wide-tree memory\n\nRun ${process.env.GITHUB_RUN_ID}; five forward/reverse rounds; Watchpack 2.6.3 uses the main compiler with its native watcher disabled.\n\n`;
md+='| Scenario and metric | Main | Before | Fix | Watchpack | Paired fix minus before | Paired fix minus main |\n|---|---:|---:|---:|---:|---:|---:|\n';
for(const scenario of scenarios){
 data[scenario]={};const group=Object.fromEntries(arms.map(arm=>[arm,rows.filter(r=>r.arm===arm&&r.scenario===scenario).sort((a,b)=>a.rep-b.rep)]));
 for(const [label,key]of metrics){
  const perArm=Object.fromEntries(arms.map(arm=>{const values=group[arm].map(r=>get(r,key));return [arm,values.length===5&&values.every(v=>v!==null)?stats(values):{median:null,n:values.length,notExposed:values.length===5&&values.every(v=>v===null)}];}));
  const pairs={};for(const base of ['before','main'])pairs[base]=perArm.fix.median!==null&&perArm[base].median!==null?{delta:stats(group.fix.map((r,i)=>get(r,key)-get(group[base][i],key))),percent:stats(group.fix.map((r,i)=>(get(r,key)/get(group[base][i],key)-1)*100))}:null;
  data[scenario][key]={arms:perArm,pairs};
  for(const base of ['before','main'])if(pairs[base]&&((key==='readinessMs'&&pairs[base].percent.median>20)||(['readinessPeakMiB','fullPeakMiB'].includes(key)&&pairs[base].percent.median>10)))large.push({scenario,metric:key,base,delta:pairs[base].delta.median,percent:pairs[base].percent.median});
  const cells=arms.map(arm=>arm==='wp'&&['editLatencyMs','watchesIdle.count'].includes(key)?'not requested':perArm[arm].median!==null?`${format(perArm[arm].median,key==='watchesIdle.count'?0:2)} [${format(perArm[arm].min,key==='watchesIdle.count'?0:2)}, ${format(perArm[arm].max,key==='watchesIdle.count'?0:2)}]`:perArm[arm].notExposed?'not exposed':`incomplete ${perArm[arm].n}/5`);
  const deltas=['before','main'].map(base=>pairs[base]?`${signed(pairs[base].delta.median)} / ${signed(pairs[base].percent.median)}%`:'not available');
  md+=`| ${scenario}, ${label} | ${cells.join(' | ')} | ${deltas.join(' | ')} |\n`;
 }
}
const summary={platform,runId:process.env.GITHUB_RUN_ID,complete,sampleCount:rows.length,outputChecks:rows.reduce((n,r)=>n+r.edits.length+r.probeRebuilds.length+1,0),controls,large,data,identities:pins};
md+=`\nSamples ${rows.length}/60; output checks ${summary.outputChecks}; controls ${controls.length}; threshold flags ${large.length}.\n`;
fs.writeFileSync(path.join(results,'summary.json'),JSON.stringify(summary,null,2)+'\n');fs.writeFileSync(path.join(results,'summary.md'),md);console.log(md);if(!complete)process.exitCode=2;
module.exports={validate};
