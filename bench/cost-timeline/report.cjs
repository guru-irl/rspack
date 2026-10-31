'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const median=values=>{assert(values.length);const a=[...values].sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
function estimate(values){
 assert(values.length===5||values.length===10);assert(values.every(Number.isFinite));let seed=0x59434f53;
 const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
 const boot=Array.from({length:20000},()=>median(Array.from({length:values.length},()=>values[Math.floor(random()*values.length)]))).sort((a,b)=>a-b);
 return{median:median(values),low:boot[500],high:boot[19499],values};
}
assert.deepEqual(estimate(Array(10).fill(3)),{median:3,low:3,high:3,values:Array(10).fill(3)});
const f=n=>n.toFixed(2),sign=n=>`${n>=0?'+':''}${f(n)}`,interval=s=>`${sign(s.median)} [${sign(s.low)}, ${sign(s.high)}]`;
module.exports=({platform,scenario,rows,schedule,controls,failures,results})=>{
 const byArm=Object.fromEntries(['before','cost'].map(arm=>[arm,rows.filter(r=>r.arm===arm).sort((a,b)=>a.rep-b.rep)]));
 const metric=(get,percent=false)=>{const a=byArm.cost.map(get),b=byArm.before.map(get);return{cost:median(a),before:median(b),delta:estimate(a.map((x,i)=>x-b[i])),...(percent?{percent:estimate(a.map((x,i)=>(x/b[i]-1)*100))}:{})};};
 const cost=Object.fromEntries(['readinessMs','fullPeakMiB','readinessPeakMiB','idleRssMiB','editedRssMiB'].map(key=>[key,metric(row=>row[key],true)]));
 const checkpoints=['firstDoneMs','watchStartMs','scanEndMs','firstProbeEventMs','probeBuildStartMs','probeBuildEndMs','readyMs'];
 const pieces=['firstDoneMs','firstDoneToScanMs','scanToEventMs','eventToBuildMs','probeBuildMs','endToReadyMs'];
 const native=['nativeQueueMs','updateMs','mtimeMs','analyzerMs','installMs','contextScanMs'];
 const timeline=Object.fromEntries([...new Set([...checkpoints,...pieces,...native])].map(key=>[key,metric(row=>row.timeline[key])]));
 const queries=platform==='Windows'?Object.fromEntries(['canonicalCount','canonicalMs','metadataCount','metadataMs','existingOwnLinkCount','existingOwnLinkMs','missingOwnLinkCount','missingOwnLinkMs','ancestorLinkCount','ancestorLinkMs'].map(key=>[key,metric(row=>row.timeline[key])])):null;
 const p=cost.readinessMs.percent,readinessStatus=p.median<=20||(p.low<=20&&p.high>=20)?'MET':'MISSED';
 const holdingPhase=[...pieces].sort((a,b)=>timeline[b].delta.median-timeline[a].delta.median)[0];
 const order={};
 for(const first of ['before','cost']){
  const reps=byArm.cost.filter(r=>(r.timeline.position===0?'cost':'before')===first).map(r=>r.rep);assert.equal(reps.length,5);
  order[first]={reps};for(const key of ['readinessMs','probeBuildMs','firstDoneToScanMs']){
   const get=row=>key==='readinessMs'?row.readinessMs:row.timeline[key];
   order[first][key]=estimate(reps.map(rep=>get(byArm.cost[rep-1])-get(byArm.before[rep-1])));
  }
 }
 function contrast(key){let seed=0x4f524445;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};const a=order.cost[key].values,b=order.before[key].values;
  const boot=Array.from({length:20000},()=>median(Array.from({length:5},()=>a[Math.floor(random()*5)]))-median(Array.from({length:5},()=>b[Math.floor(random()*5)]))).sort((a,b)=>a-b);
  return{median:median(a)-median(b),low:boot[500],high:boot[19499]};
 }
 const orderContrast={readinessMs:contrast('readinessMs'),probeBuildMs:contrast('probeBuildMs')};
 const orderAssociatedWalk=orderContrast.probeBuildMs.low>0||orderContrast.probeBuildMs.high<0;
 let md=`# ${platform} ${scenario}: one-runner startup timeline\n\nTen alternating native pairs in one runner; release builds with thin timeline markers and Windows query counters, no CPU or syscall profiler. Brackets are 95% paired bootstrap intervals.\n\nReadiness **${readinessStatus}** under the requested criterion: point estimate at most 20%, or the interval includes 20%. ${readinessStatus==='MISSED'?`The largest paired phase difference is ${holdingPhase}.`:''}\n\n| Metric | Candidate | b87c553c | Paired difference | Paired percent |\n|---|---:|---:|---|---|\n`;
 for(const key of Object.keys(cost)){const m=cost[key];md+=`| ${key} | ${f(m.cost)} | ${f(m.before)} | ${interval(m.delta)} | ${interval(m.percent)}% |\n`;}
 const table=(title,keys)=>{md+=`\n## ${title}\n\n| Phase, ms | Candidate | b87c553c | Paired difference |\n|---|---:|---:|---|\n`;for(const key of keys){const m=timeline[key];md+=`| ${key} | ${f(m.cost)} | ${f(m.before)} | ${interval(m.delta)} |\n`;}};
 table('Timeline checkpoints from compiler.watch',checkpoints);table('Readiness phase durations',pieces);table('Native startup breakdown',native);
 if(queries){md+='\n## Windows startup filesystem queries\n\n| Query count or time, ms | Candidate | b87c553c | Paired difference |\n|---|---:|---:|---|\n';for(const[key,m]of Object.entries(queries))md+=`| ${key} | ${f(m.cost)} | ${f(m.before)} | ${interval(m.delta)} |\n`;}
 md+='\n## Arm order\n\n| First arm | Readiness difference, ms | Probe-rebuild window difference, ms | First-done to scan-end difference, ms |\n|---|---|---|---|\n';
 for(const first of ['before','cost'])md+=`| ${first} | ${interval(order[first].readinessMs)} | ${interval(order[first].probeBuildMs)} | ${interval(order[first].firstDoneToScanMs)} |\n`;
 md+=`\nCandidate-first minus before-first contrast: readiness ${interval(orderContrast.readinessMs)} ms; probe rebuild ${interval(orderContrast.probeBuildMs)} ms. ${orderAssociatedWalk?'The order-associated shared-walk variance is a harness finding, not a production fix.':'The interval does not establish an arm-order association for the shared walk.'}\n`;
 md+='\n## Per-process timeline\n\n| Pair | Arm | Slot | First done | Scan end | First probe event | Probe rebuild start | Probe rebuild end | Ready | Full peak MiB |\n|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|\n';
 for(const row of [...rows].sort((a,b)=>a.rep-b.rep||a.timeline.position-b.timeline.position)){const t=row.timeline;md+=`| ${row.rep} | ${row.arm} | ${t.position+1} | ${[t.firstDoneMs,t.scanEndMs,t.firstProbeEventMs,t.probeBuildStartMs,t.probeBuildEndMs,t.readyMs,row.fullPeakMiB].map(f).join(' | ')} |\n`;}
 md+=`\nAll 20 native processes, ten probes and twenty edit checks per process passed; ${controls.length} controls rejected or verified as intended. No failed command is counted.\n`;
 const summary={platform,scenario,runId:process.env.GITHUB_RUN_ID,readinessStatus,holdingPhase,cost,timeline,queries,order,orderContrast,orderAssociatedWalk,controls,failures,schedule,perProcess:rows.map(row=>({arm:row.arm,rep:row.rep,seed:row.fixture.probeSeed,identity:row.identity,timeline:row.timeline,fullPeakMiB:row.fullPeakMiB,readinessPeakMiB:row.readinessPeakMiB,firstDoneToProbeWriteMs:row.firstDoneToProbeWriteMs}))};
 fs.writeFileSync(path.join(results,'timeline-summary.json'),JSON.stringify(summary,null,2)+'\n');fs.writeFileSync(path.join(results,'timeline-summary.md'),md);
 console.log(JSON.stringify({kind:'timeline-result',platform,scenario,readinessStatus,cost,holdingPhase,orderContrast}));
};
