const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks'),{setTimeout:delay}=require('node:timers/promises');
// Compiler dependency and callback flow reused from the supplied two-compiler harness.
module.exports=async function({fixture,arm,rep,rspack,NativeWatcher}){
 const m=JSON.parse(fs.readFileSync(path.join(fixture,'manifest.json'))),entry=path.join(fixture,'client/index.js');
 assert.equal(m.files.length,50000);assert.equal(m.missing.length,176000);assert(m.missing.every(p=>!/node_modules/.test(p)),'registered missing paths must not be ignored');
 fs.writeFileSync(entry,"require('./owner.js'); module.exports = 1;\n");for(const f of [entry,path.join(fixture,'busy/index.js')]){const past=new Date(Date.now()-10000);fs.utimesSync(f,past,past);}
 let busyDone=0,clientNative;let initial=0,editAt,receiptAt,rawReceiptAt,watchRunAt,doneAt,doneCount=0,secondWatching,clientWatching,failure,measured=false,busyNext=false,clientId,receiptGeneration;
 const watches=[],receipts=[],nativeIds=new WeakMap(),generations=new WeakMap();let nextId=0;
 function log(kind,data={}){fs.writeSync(2,'[watch-followup] '+JSON.stringify({kind,t:performance.now(),...data})+'\n');}
 const origWatch=NativeWatcher.prototype.watch;
 NativeWatcher.prototype.watch=function(...args){
  if(!nativeIds.has(this))nativeIds.set(this,++nextId);const id=nativeIds.get(this),cb=args[4],start=performance.now(),generation=(generations.get(this)||0)+1;generations.set(this,generation);if(args[0][0].includes(entry)){clientId=id;clientNative=this;}
  watches.push({id,generation,start,files:args[0][0].length,contexts:args[1][0].length,missing:args[2][0].length,removedFiles:args[0][1].length,removedContexts:args[1][1].length,removedMissing:args[2][1].length});log('register',{id,generation,files:args[0][0].length,missing:args[2][0].length});
  args[4]=(e,r)=>{if(!e){const source=r.changedFiles.includes(entry),current=generation===generations.get(this),t=performance.now();receipts.push({id,generation,current,t,source,changed:r.changedFiles.length,removed:r.removedFiles.length});if(editAt!==undefined&&source&&rawReceiptAt===undefined)rawReceiptAt=t;if(editAt!==undefined&&source&&current&&generation>1&&receiptAt===undefined){receiptAt=t;receiptGeneration=generation;log('receipt',{id,generation,changed:r.changedFiles.length});}}return cb(e,r);};
  return origWatch.apply(this,args);
 };
 const ignored=/node_modules/;
 const config=(name,plugins)=>({name,context:path.join(fixture,name),mode:'development',devtool:false,target:'node',entry:'./index.js',output:{path:path.join(fixture,'output',arm,name),filename:'bundle.js'},experiments:{nativeWatcher:true},module:{rules:[{test:/owner\.js$/,use:{loader:path.join(__dirname,'dependency-loader.cjs'),options:{manifest:path.join(fixture,'manifest.json'),role:name}}}]},plugins});
 const busy=rspack(config('busy',[c=>{c.hooks.done.tap('SteadyMeasurement',()=>{busyDone++;});c.hooks.watchRun.tap('MissingFollowup',()=>{if(busyNext){busyNext=false;log('busy-start');const end=performance.now()+1500;let x=1;while(performance.now()<end)x=Math.imul(x+1,1664525);log('busy-end',{x});}});} ]));
 const client=rspack(config('client',[c=>{
  c.hooks.watchRun.tap('MissingFollowup',()=>{if(editAt!==undefined&&watchRunAt===undefined&&c.modifiedFiles?.has(entry)){watchRunAt=performance.now();log('watchRun');}});
  c.hooks.done.tap('MissingFollowup',()=>{doneCount++;if(measured&&editAt===undefined){doneAt=performance.now();editAt=doneAt;log('done-edit');fs.writeFileSync(entry,"require('./owner.js'); module.exports = 2;\n");for(const f of m.noise)fs.writeFileSync(f,'new-'+rep);busyNext=true;secondWatching.invalidate();}});
 }]));
 function callback(e,stats){if(e||stats?.hasErrors())failure=e||new Error(stats.toString());initial++;}
 async function until(p,label){const end=Date.now()+120000;while(!p()&&Date.now()<end){if(failure)throw failure;await delay(20);}assert(p(),label);}
 try{
  secondWatching=busy.watch({aggregateTimeout:200,followSymlinks:false,ignored},callback);await until(()=>initial>=1,'busy initial build');
  clientWatching=client.watch({aggregateTimeout:200,followSymlinks:false,ignored},callback);await until(()=>doneCount>=1,'client initial build');
  await delay(25000);if(failure)throw failure;
  const first=watches.find(w=>w.id===clientId);assert(first&&first.files>=50000&&first.missing>=176000,'full dependency cardinality reached the native watcher');
  measured=true;clientWatching.invalidate();await until(()=>watchRunAt!==undefined&&receiptAt!==undefined&&doneCount>=3,'follow-up source build');
  const hot=watches.find(w=>w.id===clientId&&w.generation===receiptGeneration);assert(hot&&[hot.files,hot.contexts,hot.missing,hot.removedFiles,hot.removedContexts,hot.removedMissing].every(n=>n===0),'measured follow-up must have empty deltas');
  assert(fs.readFileSync(path.join(fixture,'output',arm,'client/bundle.js'),'utf8').includes('module.exports = 2'),'final output includes the edit');
  await until(()=>busyDone>=2,'second compiler settled');await delay(1000);if(failure)throw failure;global.gc();await delay(200);const steadyMiB=process.memoryUsage().rss/2**20;
  return {steadyMiB,files:m.files.length,registeredMissing:m.missing.length,contexts:m.contexts.length,saveToAggregateMs:receiptAt-doneAt,rawReceiptMs:rawReceiptAt-doneAt,watchRunMs:watchRunAt-doneAt,editOffsetMs:editAt-doneAt,followupEmptyDeltas:true,outputParity:true,doneCount,watches,receipts};
 }finally{
  if(clientWatching)await new Promise((ok,no)=>clientWatching.close(e=>e?no(e):ok()));if(secondWatching)await new Promise((ok,no)=>secondWatching.close(e=>e?no(e):ok()));
  await new Promise((ok,no)=>client.close(e=>e?no(e):ok()));await new Promise((ok,no)=>busy.close(e=>e?no(e):ok()));NativeWatcher.prototype.watch=origWatch;
 }
};
