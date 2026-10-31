'use strict';
const assert=require('node:assert/strict');
module.exports=sample=>{
 const once=(old,value)=>{assert.equal(sample.split(old).length,2,old);sample=sample.replace(old,value);};
 once('let start,cpuStart;','let start,cpuStart,timelineEpochMs,latestBuildStartMs,firstProbeEventMs;');
 const start='start=performance.now();cpuStart=process.cpuUsage();';
 once(start,`compiler.hooks.watchRun.tap('BenchTimeline',()=>{latestBuildStartMs=performance.now()-start;});
  assert.equal(typeof compiler.watchFileSystem.on,'function');
  for(const kind of ['change','remove'])compiler.watchFileSystem.on(kind,file=>{if(firstProbeEventMs===undefined&&byPath.has(canonical(file)))firstProbeEventMs=performance.now()-start;});
  timelineEpochMs=Date.now();${start}`);
 once('probeRebuilds.push({elapsedMs:','probeRebuilds.push({startMs:latestBuildStartMs,elapsedMs:');
 once('observerGapGuard:true,metadataOnlyInitial:true,','observerGapGuard:true,metadataOnlyInitial:true,timelineEpochMs,firstProbeEventMs,');
 return sample;
};
