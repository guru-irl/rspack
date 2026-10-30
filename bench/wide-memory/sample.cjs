'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const {performance}=require('node:perf_hooks'),{spawnSync,fork}=require('node:child_process'),{createRequire}=require('node:module');
const {read}=require('./loaded-binding-identity.cjs');
function hash(file){const h=crypto.createHash('sha256'),b=Buffer.allocUnsafe(65536),fd=fs.openSync(file,'r');try{let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest('hex');}
const [arm,scenario,repText,mode]=process.argv.slice(2),rep=Number(repText);
const refs={main:'79c650c24e4b468e743ebfe6454b3b2bc6650938',before:'b87c553ce76f2055d2ee19de589f5bbc106ff23d',fix:'90f41a8ac8200533cdc96aa31b4b818bf8a75561',wp:'79c650c24e4b468e743ebfe6454b3b2bc6650938'};
assert(arm in refs);
assert(Date.now()<Date.parse('2026-10-31T03:45:00Z'),'do not start a sample near the hard stop');
const platform={linux:'Linux',darwin:'macOS',win32:'Windows'}[process.platform],root=path.resolve('.bench-wide');
const artifact=path.join(root,'bindings',`wide-binding-${platform}-${arm==='wp'?'main':arm}`);
const manifest=JSON.parse(fs.readFileSync(path.join(artifact,'identity.json'),'utf8'));
assert.equal(manifest.source,refs[arm]);
assert.equal(fs.readFileSync(path.join(artifact,'commit.sha'),'utf8').trim(),refs[arm]);
assert.equal(manifest.profile,'release');assert.deepEqual(manifest.features,['plugin','info-level']);
assert.equal(manifest.platform,process.platform);assert.equal(manifest.arch,process.arch);
const addon=fs.realpathSync.native(path.join(artifact,'binding.node'));
process.env.NAPI_RS_NATIVE_LIBRARY_PATH=addon;
assert.equal(hash(addon),manifest.sha256,'artifact binding hash');
assert.equal(hash(path.join(artifact,'core/dist/index.js')),manifest.coreIndexHash);
const req=createRequire(path.join(artifact,'core/package.json')),{rspack}=req('./dist/index.js');
let identity;
try{identity={source:refs[arm],coreIndexHash:manifest.coreIndexHash,selected:addon,...read(addon,process.env.BENCH_EXPECTED_SHA256||manifest.sha256)};}
catch(error){console.error('WRONG_BINDING_HASH',error);process.exit(93);}
const watchpackVersion=req('./compiled/watchpack/package.json').version;assert.equal(watchpackVersion,'2.6.3');
console.log(JSON.stringify({kind:'binding-identity',arm,scenario,rep,identity,watchpackVersion}));
if(mode==='identity-only')process.exit(0);
assert(['wide','modules','symlink'].includes(scenario));assert(rep>=1&&rep<=5);
const fixture=fs.realpathSync.native(path.join(root,'fixtures',scenario)),spec=JSON.parse(fs.readFileSync(path.join(fixture,'fixture.json'),'utf8'));
const probeSet=spec.probeSets[rep-1],probes=probeSet.files.map(p=>({...p,absolute:path.join(fixture,p.file)}));
for(const p of spec.probeSets.flatMap(s=>s.files)) {
 const file=path.join(fixture,p.file);
 if(scenario==='modules')fs.writeFileSync(file,`module.exports = ${p.initialValue};\n`);
 else if(fs.existsSync(file))fs.unlinkSync(file);
}
for(const p of probes){fs.writeFileSync(p.absolute,`module.exports = ${p.initialValue};\n`);const past=new Date(Date.now()-60000);fs.utimesSync(p.absolute,past,past);}
const entries=(scenario==='modules'?spec.entries:[...spec.entries,...probes.map(p=>[p.key,p.initialValue])]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
const target=path.join(fixture,spec.target);fs.writeFileSync(target,'module.exports = 0;\n');
const output=path.join(root,'output',`${scenario}-${arm}-${rep}`),resultFile=path.join(root,'results',`${scenario}-${arm}-${rep}.json`);
assert(!fs.existsSync(resultFile),'never overwrite a counted sample');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const median=xs=>{const a=[...xs].sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=file=>path.resolve(file).toLowerCase();
const byPath=new Map(probes.map(p=>[canonical(p.absolute),p]));
function expected(version,changed=probes.map(p=>p.key)) {
 const keys=new Set(changed),values=new Map(probes.filter(p=>keys.has(p.key)).map(p=>[p.key,p.changedValue]));
 return {value:version,count:entries.length,entries:entries.map(([key,value])=>[key,key===spec.targetKey?version:values.has(key)?values.get(key):value])};
}
let firstDoneSeen=false,firstProbeWritten=false,firstProbeWriteMs;
function assertObserverAllowed(){assert(!firstDoneSeen||firstProbeWritten,'OBSERVER_IN_PROBE_GAP');}
function readRssMiB(){assertObserverAllowed();return process.memoryUsage.rss()/1048576;}
function readResourceUsage(){assertObserverAllowed();return process.resourceUsage();}
function readCpuUsage(){assertObserverAllowed();return process.cpuUsage(cpuStart);}
function windowsSnapshot(directories=false){
 assertObserverAllowed();
 const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('bench/wide-memory/observe.ps1'),'-TargetPid',String(process.pid),'-Fixture',fixture];
 if(directories)args.push('-Directories');
 const r=spawnSync('powershell.exe',args,{encoding:'utf8',timeout:60000,maxBuffer:1048576});
 assert.equal(r.status,0,r.stderr||String(r.error));return JSON.parse(r.stdout.trim());
}
function watchCount(){
 if(process.platform==='darwin')return {count:null,method:'not exposed',reason:'FSEvents stream count is not exposed by the process APIs used here'};
 if(process.platform==='win32'){const counters=windowsSnapshot(true);return {count:counters.inaccessibleHandles===0?counters.fixtureDirectoryHandles:null,method:counters.directoryMethod,...counters};}
 let count=0,instances=0;
 for(const name of fs.readdirSync('/proc/self/fdinfo')){
  let text;try{text=fs.readFileSync(`/proc/self/fdinfo/${name}`,'utf8');}catch(e){if(e.code==='ENOENT')continue;throw e;}
  const n=text.split('\n').filter(l=>l.startsWith('inotify wd:')).length;count+=n;if(n)instances++;
 }
 return {count,instances,method:'/proc/self/fdinfo inotify wd lines'};
}
let watching,compiler,sampler,probeWriter,monitor,monitorExit,monitorResult;
const watchdog=setTimeout(()=>{console.error('ARM_EDIT_FAILURE process watchdog');process.exit(94);},600000);
let pending,lastError,builds=0,expectedVersion=0,phase='initial',sampledPeak=0,firstDonePeak=0,readinessSampledPeak=0;
let firstProbeMs,readinessMs,readinessResource,readinessWindows,probeResolve,probeReject,probeTimer;
const edits=[],probeRebuilds=[],landed=new Map(),rewrites=new Map(probes.map(p=>[p.key,0]));
let start,cpuStart;
function next(version){
 assert(!pending,'one outstanding edit');expectedVersion=version;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending=undefined;reject(new Error(`ARM_EDIT_FAILURE ${arm}/${scenario}/${rep} version ${version} timed out`));},120000);
  pending={resolve:value=>{clearTimeout(timer);pending=undefined;resolve(value);},reject:error=>{clearTimeout(timer);pending=undefined;reject(error);}};
 });
}
function fail(error){lastError=String(error);pending?.reject(error);probeReject?.(error);}
function onBuild(error,stats){
 const arrived=performance.now();
 if(phase==='initial'){
  firstDoneSeen=true;builds++;
  if(mode==='observer-negative')readRssMiB();
  pending.resolve({arrived,error,stats,sampledAtDone:firstDonePeak});
  return;
 }
 const resource=readResourceUsage(),rss=readRssMiB(),cpu=readCpuUsage();
 builds++;
 if(error||stats.hasErrors()){fail(new Error(String(error||stats.toString({all:false,errors:true}))));return;}
 try{
  assert(resource.maxRSS>0,'OS RSS high-water counter required');
  const initialWindows=null;
  const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(output,'bundle.js'),'utf8'),{module},{timeout:20000});
  const actualHash=digest(module.exports),modifiedFiles=[...compiler.modifiedFiles||[]];
  if(phase==='probes'){
   const values=new Map(module.exports.entries),changed=[];
   for(const p of probes){const value=values.get(p.key);assert(value===p.initialValue||value===p.changedValue,'unexpected probe export');if(value===p.changedValue)changed.push(p.key);}
   for(const file of modifiedFiles){const p=byPath.get(canonical(file));if(!p)continue;assert.equal(values.get(p.key),p.changedValue,'ARM_EDIT_FAILURE stale probe export');if(!landed.has(p.key))landed.set(p.key,arrived-start);}
   assert.equal(actualHash,digest(expected(0,changed)),'ARM_EDIT_FAILURE probe output parity');
   if(landed.size>0&&firstProbeMs===undefined)firstProbeMs=arrived-start;
   probeRebuilds.push({elapsedMs:arrived-start,modifiedFiles:modifiedFiles.map(file=>path.relative(fixture,file).split(path.sep).join('/')),changed,actualHash,expectedHash:digest(expected(0,changed)),outputMatches:true});
   if(landed.size===10){
    assert.equal(actualHash,digest(expected(0)),'ARM_EDIT_FAILURE final probe output');
    readinessMs=arrived-start;readinessResource=resource;
    readinessWindows=null;
    readinessSampledPeak=Math.max(readinessSampledPeak,rss);
    clearInterval(probeWriter);clearTimeout(probeTimer);phase='idle';probeResolve();
   }
   return;
  }
  const expectedHash=digest(expected(expectedVersion,phase==='initial'?[]:undefined));
  assert.equal(actualHash,expectedHash,`ARM_EDIT_FAILURE stale output at version ${expectedVersion}`);
  const row={version:expectedVersion,arrived,actualHash,expectedHash,outputMatches:true,resource,cpu,sampledAtDone:Math.max(firstDonePeak,rss),windows:initialWindows};
  if(pending)pending.resolve(row);
 }catch(error){fail(error);}
}
(async()=>{
 let baseline,initial,inotify;
 try{
  if(process.platform==='linux'){
   monitor=fork(path.resolve('bench/wide-memory/inotify.cjs'),[String(process.pid),path.join(root,'results',`${scenario}-${arm}-${rep}-inotify.json`)],{stdio:['ignore','inherit','inherit','ipc']});
   monitorExit=new Promise((resolve,reject)=>{monitor.once('exit',code=>code===0?resolve():reject(new Error(`inotify monitor exited ${code}`)));});
   monitorExit.catch(error=>fail(error));
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('monitor startup timed out')),10000);monitor.once('message',message=>{clearTimeout(timer);assert.equal(message.kind,'ready');resolve();});});
   monitorResult=new Promise(resolve=>monitor.on('message',message=>{if(message.kind==='inotify-stability')resolve(message);}));
  }
  baseline={rssMiB:readRssMiB(),resource:readResourceUsage()};firstDonePeak=baseline.rssMiB;
  sampler=setInterval(()=>{const rss=readRssMiB();sampledPeak=Math.max(sampledPeak,rss);if(phase==='initial')firstDonePeak=Math.max(firstDonePeak,rss);if(['initial','probes'].includes(phase))readinessSampledPeak=Math.max(readinessSampledPeak,rss);},10);
  compiler=rspack({context:fixture,mode:'development',devtool:false,target:'node',entry:'./index.js',resolve:{symlinks:false},output:{path:output,filename:'bundle.js',library:{type:'commonjs2'}},experiments:{nativeWatcher:arm!=='wp'}});
  start=performance.now();cpuStart=process.cpuUsage();
  monitor?.send({kind:'start',startEpoch:performance.timeOrigin+start});
  const first=next(0);watching=compiler.watch({aggregateTimeout:50,followSymlinks:true},onBuild);initial=await first;
  phase='probes';
  const ready=new Promise((resolve,reject)=>{probeResolve=resolve;probeReject=reject;probeTimer=setTimeout(()=>reject(new Error(`ARM_EDIT_FAILURE readiness probes missing: ${probes.filter(p=>!landed.has(p.key)).map(p=>p.file).join(',')}`)),120000);});
  const rewrite=()=>{try{for(const p of probes)if(!landed.has(p.key)){const n=rewrites.get(p.key)+1;rewrites.set(p.key,n);if(!firstProbeWritten)firstProbeWriteMs=performance.now()-start;fs.writeFileSync(p.absolute,`module.exports = ${p.changedValue}; // probe rewrite ${n}\n`);firstProbeWritten=true;}}catch(error){fail(error);}};
  rewrite();probeWriter=setInterval(rewrite,200);
  assert(!initial.error,String(initial.error));assert(!initial.stats.hasErrors(),initial.stats.toString({all:false,errors:true}));
  const initialModule={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(output,'bundle.js'),'utf8'),{module:initialModule},{timeout:20000});
  initial.actualHash=digest(initialModule.exports);initial.expectedHash=digest(expected(0,[]));
  assert.equal(initial.actualHash,initial.expectedHash,'ARM_EDIT_FAILURE initial output');
  assert(Object.values(initial).every(value=>value==null||typeof value!=='object'),'INITIAL_METADATA_RETAINED_OBJECT');
  await ready;probeReject=undefined;
  const idleSamples=[];for(let second=1;second<=10;second++){await wait(1000);if(second>=6)idleSamples.push(readRssMiB());}
  if(lastError)throw new Error(lastError);
  if(monitor){monitor.send({kind:'stop'});inotify=await monitorResult;await monitorExit;assert(inotify.stableMs!==null,'inotify count did not stabilize for 2400 ms');}
  const watchesIdle=watchCount();phase='edits';
  for(let version=1;version<=20;version++){
   await wait(250);const done=next(version),editStart=performance.now();fs.writeFileSync(target,`module.exports = ${version};\n`);const receipt=await done;
   edits.push({version,latencyMs:receipt.arrived-editStart,actualHash:receipt.actualHash,expectedHash:receipt.expectedHash,outputMatches:true});
  }
  await wait(3000);const editedSamples=[];for(let i=0;i<5;i++){await wait(1000);editedSamples.push(readRssMiB());}
  if(lastError)throw new Error(lastError);
  const watchesEdited=watchCount(),finalResource=readResourceUsage(),windows=process.platform==='win32'?windowsSnapshot():null;
  const highWater=(resource,win)=>(win?.peakWorkingSetBytes||resource.maxRSS*1024)/1048576;
  const result={arm,scenario,rep,platform,arch:process.arch,node:process.version,identity,watchpackVersion,
   fixture:{folders:spec.folders,fillerFiles:spec.fillerFiles,moduleCount:entries.length,symlinkFiles:spec.symlinkFiles,probeSeed:probeSet.seed,probeCount:10},baseline,
   firstDoneMs:initial.arrived-start,firstProbeWriteMs,firstDoneToProbeWriteMs:firstProbeWriteMs-(initial.arrived-start),observerGapGuard:true,
   firstDonePeakMiB:initial.sampledAtDone,firstDonePeakMethod:'10 ms sampled RSS; no observer in the probe gap',firstDoneResource:null,firstDoneCpu:null,
   readinessMs,firstProbeMs,readinessPeakMiB:Math.max(readinessSampledPeak,highWater(readinessResource,readinessWindows)),readinessResource,
   probes:probes.map(p=>({file:p.file,key:p.key,landedMs:landed.get(p.key),rewrites:rewrites.get(p.key)})),probeRebuilds,
   inotifyStableMs:inotify?.stableMs??null,inotify:inotify?{...inotify,samples:undefined}:null,
   idleRssMiB:median(idleSamples),idleSamples,editedRssMiB:median(editedSamples),editedSamples,
   fullPeakMiB:Math.max(sampledPeak,highWater(finalResource,windows)),editLatencyMs:median(edits.map(e=>e.latencyMs)),watchesIdle,watchesEdited,edits,
   initial:{version:0,actualHash:initial.actualHash,expectedHash:initial.expectedHash,outputMatches:true},builds,finalResource,windows,outputParity:true};
  fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({kind:'completed-sample',arm,scenario,rep,firstDoneMs:result.firstDoneMs,readinessMs,firstProbeMs,inotifyStableMs:result.inotifyStableMs,fullPeakMiB:result.fullPeakMiB,idleRssMiB:result.idleRssMiB,editedRssMiB:result.editedRssMiB,editLatencyMs:result.editLatencyMs,watchesIdle}));
 }finally{
  clearInterval(sampler);clearInterval(probeWriter);clearTimeout(probeTimer);clearTimeout(watchdog);
  if(monitor?.connected)monitor.disconnect();
  if(monitor&&!monitor.killed)monitor.kill();
  if(watching)await new Promise(resolve=>watching.close(resolve));
  if(compiler)await new Promise(resolve=>compiler.close(resolve));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
