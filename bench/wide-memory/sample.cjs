'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const {performance} = require('node:perf_hooks');
const {spawnSync} = require('node:child_process');
const {createRequire} = require('node:module');
const {hash, read} = (() => { const id = require('./loaded-binding-identity.cjs'); return {...id, hash: file => { const h=crypto.createHash('sha256'), b=Buffer.allocUnsafe(65536), fd=fs.openSync(file,'r'); try { let n; while((n=fs.readSync(fd,b,0,b.length,null))>0) h.update(b.subarray(0,n)); } finally { fs.closeSync(fd); } return h.digest('hex'); }}; })();
const [arm, scenario, repText, mode] = process.argv.slice(2), rep = Number(repText);
const refs = {main:'79c650c24e4b468e743ebfe6454b3b2bc6650938',before:'b87c553ce76f2055d2ee19de589f5bbc106ff23d',fix:'90f41a8ac8200533cdc96aa31b4b818bf8a75561',wp:'79c650c24e4b468e743ebfe6454b3b2bc6650938'};
assert(arm in refs);
assert(Date.now()<Date.parse('2026-10-31T03:45:00Z'),'do not start a sample near the hard stop');
const platform = {linux:'Linux',darwin:'macOS',win32:'Windows'}[process.platform];
const root = path.resolve('.bench-wide');
const artifact = path.join(root,'bindings',`wide-binding-${platform}-${arm === 'wp' ? 'main' : arm}`);
const manifest = JSON.parse(fs.readFileSync(path.join(artifact,'identity.json'),'utf8'));
assert.equal(manifest.source, refs[arm]);
assert.equal(fs.readFileSync(path.join(artifact,'commit.sha'),'utf8').trim(), refs[arm]);
assert.equal(manifest.profile,'release');
assert.deepEqual(manifest.features,['plugin','info-level']);
assert.equal(manifest.platform, process.platform);
assert.equal(manifest.arch, process.arch);
const addon = fs.realpathSync.native(path.join(artifact,'binding.node'));
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon;
assert.equal(hash(addon),manifest.sha256,'artifact binding hash');
assert.equal(hash(path.join(artifact,'core/dist/index.js')),manifest.coreIndexHash);
const req = createRequire(path.join(artifact,'core/package.json'));
const {rspack} = req('./dist/index.js');
let identity;
try { identity = {source:refs[arm],coreIndexHash:manifest.coreIndexHash,selected:addon,...read(addon,process.env.BENCH_EXPECTED_SHA256 || manifest.sha256)}; }
catch(error) { console.error('WRONG_BINDING_HASH',error); process.exit(93); }
const watchpackVersion = req('watchpack/package.json').version;
assert.equal(watchpackVersion,'2.6.3');
console.log(JSON.stringify({kind:'binding-identity',arm,scenario,rep,identity,watchpackVersion}));
if(mode==='identity-only') process.exit(0);
assert(['wide','modules','symlink'].includes(scenario));
assert(rep>=1 && rep<=5);
const fixture = fs.realpathSync.native(path.join(root,'fixtures',scenario));
const spec = JSON.parse(fs.readFileSync(path.join(fixture,'fixture.json'),'utf8'));
const target = path.join(fixture,spec.target);
fs.writeFileSync(target,'module.exports = 0;\n');
const output = path.join(root,'output',`${scenario}-${arm}-${rep}`);
const resultFile = path.join(root,'results',`${scenario}-${arm}-${rep}.json`);
assert(!fs.existsSync(resultFile),'never overwrite a counted sample');
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
const median = xs => {const a=[...xs].sort((a,b)=>a-b), m=Math.floor(a.length/2);return a.length%2 ? a[m]:(a[m-1]+a[m])/2;};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const expected = version => ({value:version,count:spec.entries.length,entries:spec.entries.map(([k,v])=>[k,k===spec.targetKey ? version:v])});
function windowsSnapshot(directories=false) {
 const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('bench/wide-memory/observe.ps1'),'-TargetPid',String(process.pid),'-Fixture',fixture];
 if(directories) args.push('-Directories');
 const r=spawnSync('powershell.exe',args,{encoding:'utf8',timeout:60000,maxBuffer:1048576});
 assert.equal(r.status,0,r.stderr || String(r.error));
 return JSON.parse(r.stdout.trim());
}
function watchCount() {
 if(process.platform==='darwin') return {count:null,method:'not exposed',reason:'FSEvents stream count is not exposed by the process APIs used here'};
 if(process.platform==='win32') {
  const counters=windowsSnapshot(true);
  return {count:counters.inaccessibleHandles===0 ? counters.fixtureDirectoryHandles:null,method:counters.directoryMethod,...counters};
 }
 let count=0,instances=0;
 for(const name of fs.readdirSync('/proc/self/fdinfo')) {
  let text;
  try { text=fs.readFileSync(`/proc/self/fdinfo/${name}`,'utf8'); }
  catch(e) { if(e.code==='ENOENT') continue; throw e; }
  const n=text.split('\n').filter(l=>l.startsWith('inotify wd:')).length;
  count+=n;
  if(n) instances++;
 }
 return {count,instances,method:'/proc/self/fdinfo inotify wd lines'};
}
const watchdog=setTimeout(()=>{console.error('ARM_EDIT_FAILURE process watchdog');process.exit(94);},600000);
let pending, lastError, builds=0, expectedVersion=0, startupSampledPeak=0, sampledPeak=0, startup=true;
const edits=[];
const baseline={rssMiB:process.memoryUsage.rss()/1048576,resource:process.resourceUsage()};
const sampler=setInterval(()=>{
 const rss=process.memoryUsage.rss()/1048576;
 sampledPeak=Math.max(sampledPeak,rss);
 if(startup) startupSampledPeak=Math.max(startupSampledPeak,rss);
},10);
const compiler=rspack({context:fixture,mode:'development',devtool:false,target:'node',entry:'./index.js',
 cache:false,resolve:{symlinks:false},
 output:{path:output,filename:'bundle.js',library:{type:'commonjs2'}},
 experiments:{nativeWatcher:arm!=='wp'}});
let watching;
const start=performance.now(), cpuStart=process.cpuUsage();
function next(version) {
 assert(!pending,'one outstanding rebuild');
 expectedVersion=version;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending=undefined;reject(new Error(`ARM_EDIT_FAILURE ${arm}/${scenario}/${rep} version ${version} timed out`));},120000);
  pending={resolve:value=>{clearTimeout(timer);pending=undefined;resolve(value);},reject:error=>{clearTimeout(timer);pending=undefined;reject(error);}};
 });
}
const first=next(0);
watching=compiler.watch({aggregateTimeout:50,followSymlinks:true},(error,stats)=>{
 const arrived=performance.now();
 const resource=process.resourceUsage();
 const sampledAtDone=Math.max(startupSampledPeak,process.memoryUsage.rss()/1048576);
 const cpu=process.cpuUsage(cpuStart);
 const startupWindows=startup && process.platform==='win32' ? windowsSnapshot():null;
 builds++;
 if(error || stats.hasErrors()) {
  lastError=String(error || stats.toString({all:false,errors:true}));
  pending?.reject(new Error(lastError));return;
 }
 try {
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(output,'bundle.js'),'utf8'),{module},{timeout:20000});
  const actualHash=digest(module.exports), expectedHash=digest(expected(expectedVersion));
  assert.equal(actualHash,expectedHash,`ARM_EDIT_FAILURE stale output at version ${expectedVersion}`);
  const row={version:expectedVersion,arrived,actualHash,expectedHash,outputMatches:true,resource,cpu,sampledAtDone};
  if(startup) {
   startup=false;
   row.windows=startupWindows;
  }
  if(pending) pending.resolve(row);
 } catch(e) {lastError=String(e);pending?.reject(e);}
});
(async()=>{
 try {
  const initial=await first;
  const startupMs=initial.arrived-start;
  const startupPeakMiB=Math.max(initial.sampledAtDone,(initial.windows?.peakWorkingSetBytes || initial.resource.maxRSS*1024)/1048576);
  const idleSamples=[];
  for(let second=1;second<=10;second++) {await wait(1000);if(second>=6) idleSamples.push(process.memoryUsage.rss()/1048576);}
  if(lastError) throw new Error(lastError);
  const watchesIdle=watchCount();
  for(let version=1;version<=20;version++) {
   await wait(250);
   const done=next(version), editStart=performance.now();
   fs.writeFileSync(target,`module.exports = ${version};\n`);
   const receipt=await done;
   edits.push({version,latencyMs:receipt.arrived-editStart,actualHash:receipt.actualHash,expectedHash:receipt.expectedHash,outputMatches:receipt.outputMatches});
  }
  await wait(3000);
  const editedSamples=[];
  for(let i=0;i<5;i++) {await wait(1000);editedSamples.push(process.memoryUsage.rss()/1048576);}
  if(lastError) throw new Error(lastError);
  const watchesEdited=watchCount();
  const finalResource=process.resourceUsage(), windows=process.platform==='win32' ? windowsSnapshot():null;
  const result={arm,scenario,rep,platform,arch:process.arch,node:process.version,identity,watchpackVersion,
   fixture:{folders:spec.folders,fillerFiles:spec.fillerFiles,moduleCount:spec.moduleCount,symlinkFiles:spec.symlinkFiles},
   baseline,startupMs,startupPeakMiB,startupSampledPeakMiB:initial.sampledAtDone,startupResource:initial.resource,startupCpu:initial.cpu,
   idleRssMiB:median(idleSamples),idleSamples,editedRssMiB:median(editedSamples),editedSamples,
   fullPeakMiB:Math.max(sampledPeak,(windows?.peakWorkingSetBytes || finalResource.maxRSS*1024)/1048576),
   editLatencyMs:median(edits.map(e=>e.latencyMs)),watchesIdle,watchesEdited,edits,initial:{version:0,actualHash:initial.actualHash,expectedHash:initial.expectedHash,outputMatches:true},
   builds,finalResource,windows,outputParity:true};
  fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({kind:'completed-sample',arm,scenario,rep,startupMs,startupPeakMiB,idleRssMiB:result.idleRssMiB,editedRssMiB:result.editedRssMiB,editLatencyMs:result.editLatencyMs,watchesIdle}));
 } finally {
  clearInterval(sampler);clearTimeout(watchdog);
  await new Promise(resolve=>watching.close(resolve));
  await new Promise(resolve=>compiler.close(resolve));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
