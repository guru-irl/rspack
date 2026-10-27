const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks'),{setTimeout:delay}=require('node:timers/promises');
module.exports=async function({fixture,arm,rep,rspack,sources,NativeWatcher}){
 const m=JSON.parse(fs.readFileSync(path.join(fixture,'manifest.json'))),files=m.files,contexts=m.contexts,entry=path.join(fixture,'index.js'),target=files[0];
 assert.equal(files.length,80000);assert.equal(contexts.length,3000);
 const past=new Date(Date.now()-60000);for(const [file,text]of [[entry,'module.exports = 1;'],[target,'original']]){fs.writeFileSync(file,text);fs.utimesSync(file,past,past);}
 let native,watchCount=0,generation=0,builds=0,readBuild=0,failure,enabled=false,active;
 const writes=[],emitted=[],watches=[],orig=NativeWatcher.prototype.watch;
 NativeWatcher.prototype.watch=function(...args){
  native=this;const currentGeneration=++generation;
  args[0][0]=[...new Set([...args[0][0],...files])];args[1][0]=[...new Set([...args[1][0],...contexts])];
  assert(args[0][0].length>=80000&&args[1][0].length>=3000,'full registrations re-sent on every application');
  const record={generation:currentGeneration,files:args[0][0].length,contexts:args[1][0].length,missing:args[2][0].length};watches.push(record);watchCount++;
  const callback=args[4];args[4]=(error,result)=>{
   if(error)failure=error;
   if(active&&result?.changedFiles.includes(target)&&active.receiptAt===undefined){active.receiptAt=performance.now();active.callbackGeneration=currentGeneration;active.current=currentGeneration===generation;}
   return callback(error,result);
  };
  // This is synchronous dispatch duration, not asynchronous Rust application time.
  const start=performance.now();const result=orig.apply(this,args);record.dispatchMs=performance.now()-start;return result;
 };
 const output=path.join(fixture,'output',`${arm}-${rep}`);
 const compiler=rspack({context:fixture,mode:'development',devtool:false,target:'node',entry:'./index.js',output:{path:output},experiments:{nativeWatcher:true},plugins:[c=>{
  c.hooks.watchRun.tap('ResendMeasurements',()=>{if(active&&active.watchRunAt===undefined&&c.modifiedFiles?.has(target))active.watchRunAt=performance.now();});
  c.hooks.thisCompilation.tap('ResendMeasurements',compilation=>{
   readBuild++;for(const file of files)compilation.fileDependencies.add(file);for(const dir of contexts)compilation.contextDependencies.add(dir);compilation.fileDependencies.add(path.join(fixture,`ready-${Math.min(readBuild,7)}.txt`));
   const value=fs.readFileSync(target,'utf8');emitted.push(value);compilation.emitAsset('snapshot.txt',new sources.RawSource(value));
  });
  c.hooks.done.tap('ResendMeasurements',()=>{if(enabled&&readBuild>=2&&readBuild<4){assert(!active||active.receiptAt!==undefined&&active.watchRunAt!==undefined,'previous edit was observed');const value=`value-${readBuild-1}`;active={build:readBuild,value,savedAt:performance.now()};writes.push(active);fs.writeFileSync(target,value);}});
 }]});
 const watching=compiler.watch({aggregateTimeout:50},(error,stats)=>{failure=error||(stats?.hasErrors()?new Error(stats.toString()):failure);builds++;});
 async function until(predicate,label){const end=Date.now()+180000;while(!predicate()&&Date.now()<end){if(failure)throw failure;await delay(10);}assert(predicate(),label);}
 function ready(marker){if(failure)throw failure;if(!native)return false;const info=native.collectTimeInfoEntries();const known=new Set(info.fileTimestamps.entries.map(row=>row.path));return known.has(marker)&&known.has(entry)&&files.every(file=>known.has(file));}
 try{
  await until(()=>builds>=1&&ready(path.join(fixture,'ready-1.txt')),'initial full registration');assert.equal(builds,1);
  global.gc();await delay(1000);enabled=true;fs.writeFileSync(entry,'module.exports = 2;');
  await until(()=>builds>=4&&watchCount>=4&&ready(path.join(fixture,'ready-4.txt')),'three rebuilds and final rewatch');
  assert.equal(builds,4);assert.equal(writes.length,2);assert.deepEqual(emitted,['original','original','value-1','value-2']);assert.equal(fs.readFileSync(path.join(output,'snapshot.txt'),'utf8'),'value-2');
  for(const row of writes)assert(row.receiptAt>=row.savedAt&&row.watchRunAt>=row.receiptAt&&row.current,'edited file reached the current aggregate callback before watchRun');
  await delay(1000);if(failure)throw failure;global.gc();await delay(200);const steadyMiB=process.memoryUsage().rss/2**20;
  return {files:files.length,contexts:contexts.length,unchangedRegistrationsResent:true,rebuilds:3,outputParity:true,steadyMiB,saveToAggregateMs:writes.map(row=>row.receiptAt-row.savedAt),saveToWatchRunMs:writes.map(row=>row.watchRunAt-row.savedAt),writes,watches,watcherApplyTimeRecorded:false};
 }finally{await new Promise((ok,no)=>watching.close(error=>error?no(error):ok()));await new Promise((ok,no)=>compiler.close(error=>error?no(error):ok()));NativeWatcher.prototype.watch=orig;}
};
