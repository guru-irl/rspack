'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
assert.equal(process.platform,'linux');
const [pid,output]=process.argv.slice(2);
let start, timer;
const samples=[];
function count() {
 let watches=0,instances=0;
 for(const name of fs.readdirSync(`/proc/${pid}/fdinfo`)) {
  let text;
  try {text=fs.readFileSync(`/proc/${pid}/fdinfo/${name}`,'utf8');}
  catch(e){if(e.code==='ENOENT')continue;throw e;}
  const n=text.split('\n').filter(line=>line.startsWith('inotify wd:')).length;
  watches+=n;if(n)instances++;
 }
 return {watches,instances};
}
function tick(){samples.push({elapsedMs:performance.timeOrigin+performance.now()-start,...count()});}
process.on('message',message=>{
 if(message.kind==='start') {start=message.startEpoch;tick();timer=setInterval(tick,200);}
 if(message.kind==='stop') {
  clearInterval(timer);tick();
  const final=samples.at(-1),positive=samples.filter(s=>s.watches>0);
  assert(positive.length>0,'no inotify watches observed');
  let lastChange=0;
  for(let i=1;i<samples.length;i++) if(samples[i].watches!==samples[i-1].watches)lastChange=i;
  const changedAt=samples[lastChange].elapsedMs;
  const stable=samples.slice(lastChange).find(s=>s.elapsedMs-changedAt>=2400);
  const result={kind:'inotify-stability',intervalMs:200,windowMs:2400,stableCount:final.watches,lastChangeMs:changedAt,stableMs:stable?.elapsedMs??null,firstNonzeroMs:positive[0].elapsedMs,samples};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  process.send({...result,samples:undefined},()=>process.disconnect());
 }
});
process.send({kind:'ready'});
