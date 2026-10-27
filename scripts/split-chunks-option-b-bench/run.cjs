const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve('.bench-split-chunks-option-b');
const fixture = path.join(root, 'fixture');
const files = Array.from({ length: 80000 }, (_, i) => path.join(fixture, 'contexts', String(i % 3000), `file-${i}.txt`));
const contexts = Array.from({ length: 3000 }, (_, i) => path.join(fixture, 'contexts', String(i)));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const ns = () => process.hrtime.bigint();
const elapsed = start => Number(ns() - start) / 1e6;
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const refs = { restack: '95c672a381ed713e582265e637badec09372eda3', final: 'ab0d71011539025cc03db06a8ac7788ce42c7c6a' };
if (process.argv[2] === '--prepare') {
 fs.mkdirSync(path.join(root, 'results'), { recursive: true });
 fs.mkdirSync(fixture, { recursive: true });
 const past = new Date(Date.now() - 60000);
 for (const dir of contexts) fs.mkdirSync(dir, { recursive: true });
 for (const file of files) { fs.writeFileSync(file, 'original'); fs.utimesSync(file, past, past); }
 fs.writeFileSync(path.join(fixture, 'index.js'), 'module.exports = 1;');
 for (let i=0;i<8;i++) fs.writeFileSync(path.join(fixture, `ready-${i}.txt`), 'ready');
 for (const p of [path.join(fixture, 'index.js'), ...Array.from({ length:8 }, (_,i) => path.join(fixture, `ready-${i}.txt`))]) fs.utimesSync(p, past, past);
 console.log(JSON.stringify({ kind: 'fixture', files: files.length, contexts: contexts.length }));
 process.exit(0);
}
const [arm, scenario, repText] = process.argv.slice(2);
assert(arm in refs);
const rep = Number(repText); assert(rep >= 1 && rep <= 5);
const platform = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[process.platform];
assert(platform); assert.equal(process.arch, process.platform === 'darwin' ? 'arm64' : 'x64');
const artifact = path.join(root, 'bindings', `optb-binding-${platform}-${arm}`);
assert.equal(fs.readFileSync(path.join(artifact, 'commit.sha'), 'utf8').trim(), refs[arm]);
const addon = fs.realpathSync(path.join(artifact, 'binding.node'));
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon;
const req = createRequire(path.join(artifact, 'core/package.json'));
const { rspack, sources } = req('./dist/index.js');
const { NativeWatcher } = req('@rspack/binding');
const objects = process.platform === 'linux'
 ? [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n').filter(l => /\.node(?:$| \(deleted\))/.test(l)).map(l => l.slice(l.indexOf('/'))))]
 : process.report.getReport().sharedObjects;
assert(Array.isArray(objects), 'loaded-object report required');
const mapped = objects.filter(p => p === addon || /(?:rspack[^/\\]*|binding)\.node$/i.test(p)).map(p => fs.realpathSync(p));
assert.deepEqual([...new Set(mapped)], [addon], 'exactly the selected binding must be loaded');
const identity = { source: refs[arm], sha256: hash(addon), mapped: [...new Set(mapped)], report: process.platform === 'linux' ? '/proc/self/maps' : 'process.report.sharedObjects' };
console.log(JSON.stringify({ kind: 'binding-identity', arm, scenario, rep, ...identity }));
const output = path.join(root, 'results', `${arm}-${scenario}-${rep}.json`);
assert(!fs.existsSync(output), 'never overwrite a sample');
const usageStart = process.resourceUsage();
let sampledPeak = process.memoryUsage().rss;
const sampler = setInterval(() => { sampledPeak = Math.max(sampledPeak, process.memoryUsage().rss); }, 10);
const rss = () => process.memoryUsage().rss / 1024 ** 2;
function peak() {
 let bytes = Math.max(sampledPeak, process.resourceUsage().maxRSS * 1024);
 if (process.platform === 'win32') {
  const p = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).PeakWorkingSet64`], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr); const value = Number(p.stdout.trim()); assert(value > 0); bytes = Math.max(bytes, value);
 }
 return bytes / 1024 ** 2;
}
async function until(predicate, label) {
 const start = ns();
 while (!predicate()) { assert(elapsed(start) < 180000, `timeout: ${label}`); await delay(10); }
}
async function missingHeavy() {
 const missing = Array.from({ length: 80000 }, (_,i) => path.join(fixture, 'absent', String(i % 3000), `missing-${i}.js`));
 const watcher = new NativeWatcher({ aggregateTimeout: 50, followSymlinks: true });
 const rounds = [];
 let error, delivered = -1;
 try {
  for (let round=0;round<6;round++) {
   const marker = path.join(fixture, `ready-${round}.txt`);
   const start=ns();
   watcher.watch([[marker], round ? [path.join(fixture, `ready-${round-1}.txt`)] : []], [[],[]], [missing,[]], 0n,
    (e,r) => { if (e) error=e; if (r?.changedFiles.includes(marker)) delivered=round; }, () => {});
   await until(() => { if (error) throw error; return delivered===round; }, 'missing watch applied');
   if (round) rounds.push(elapsed(start));
   watcher.pause();
  }
  assert.equal(rounds.length,5);
  global.gc();
  return { missing: missing.length, unchangedApplications: rounds.length, missingHeavyMs: median(rounds), applicationMs: rounds, steadyMiB: rss() };
 } finally { await watcher.close(); }
}
async function latency() {
 assert(['offset0-edit','files-only','contexts-only','rewrite600'].includes(scenario));
 const useFiles=scenario!=='contexts-only', useContexts=scenario!=='files-only';
 const targets=scenario==='rewrite600'?files.slice(0,600):[files[0]], entry=path.join(fixture,'index.js');
 const old=new Date(Date.now()-60000);for(const target of targets){fs.writeFileSync(target,'original');fs.utimesSync(target,old,old);}
 fs.writeFileSync(entry,'module.exports = 1;');fs.utimesSync(entry,old,old);
 let native, firstWatch, watchCount=0, builds=0, readBuild=0, failure, enabled=false, lastWrite, expected='original';
 const emitted=[], latencies=[], writes=[];
 const watch=NativeWatcher.prototype.watch;
 NativeWatcher.prototype.watch=function(...args) { native=this; firstWatch ??= ns();watchCount++;return watch.apply(this,args); };
 const options={context:fixture,mode:'development',devtool:false,target:'node',entry:'./index.js',output:{path:path.join(fixture,`dist-${arm}-${scenario}-${rep}`)},experiments:{nativeWatcher:true},plugins:[compiler=>{
  compiler.hooks.watchRun.tap('Measurements',()=>{if(lastWrite){latencies.push(elapsed(lastWrite));lastWrite=undefined;}});
  compiler.hooks.thisCompilation.tap('Measurements',compilation=>{
   readBuild++;
   if(useFiles)for(const file of files)compilation.fileDependencies.add(file);
   if(useContexts)for(const dir of contexts)compilation.contextDependencies.add(dir);
   compilation.fileDependencies.add(path.join(fixture,`ready-${Math.min(readBuild,7)}.txt`));
   const value=targets.map(target=>fs.readFileSync(target,'utf8')).join('\n');emitted.push(value);
   compilation.emitAsset('snapshot.txt',new sources.RawSource(value));
  });
  compiler.hooks.done.tap('Measurements',()=>{
   if(enabled && readBuild>=2 && readBuild<4){expected=`value-${readBuild-1}`;lastWrite=ns();writes.push({build:readBuild,value:expected});for(const target of targets)fs.writeFileSync(target,expected);}
  });
 }]};
 const started=ns();const compiler=rspack(options);
 const watching=compiler.watch({aggregateTimeout:50},(e,stats)=>{failure=e||(stats?.hasErrors()?new Error(stats.toString()):failure);builds++;});
 const ready=marker=>{
  if(failure)throw failure;if(!native)return false;
  const info=native.collectTimeInfoEntries();const f=new Map(info.fileTimestamps),d=new Map(info.directoryTimestamps);
  const present=p=>f.has(p)&&f.get(p)!==null;
  return present(entry)&&present(marker)&&(!useFiles||files.every(p=>present(p)))&&(!useContexts||contexts.every(p=>d.has(p)&&d.get(p)!==null));
 };
 try {
  await until(()=>builds>=1&&ready(path.join(fixture,'ready-1.txt')),'first registration');
  assert.equal(builds,1,'unexpected startup rebuild');
  const firstReadyMs=elapsed(firstWatch),startupReadyMs=elapsed(started),afterRegistrationMiB=rss();
  global.gc();const afterGcMiB=rss();
  enabled=true;fs.writeFileSync(entry,'module.exports = 2;');
  await until(()=>builds>=4&&watchCount>=4&&ready(path.join(fixture,'ready-4.txt')),'three rebuilds');
  assert.equal(builds,4,'exactly three rebuilds');assert.equal(latencies.length,2,'two offset-zero writes');
  assert.deepEqual(emitted,['original','original','value-1','value-2'].map(value=>targets.map(()=>value).join('\n')));
  assert.equal(fs.readFileSync(path.join(options.output.path,'snapshot.txt'),'utf8'),targets.map(()=>'value-2').join('\n'));
  const afterThreeMiB=rss();global.gc();const steadyMiB=rss();
  return {rewrittenFiles:targets.length,files:useFiles?files.length:0,contexts:useContexts?contexts.length:0,firstReadyMs,startupReadyMs,afterRegistrationMiB,afterGcMiB,afterThreeMiB,steadyMiB,rebuildLatencyMs:median(latencies),latencies,writes,rebuilds:builds-1,outputParity:true};
 } finally {await new Promise((resolve,reject)=>watching.close(e=>e?reject(e):resolve()));await new Promise((resolve,reject)=>compiler.close(e=>e?reject(e):resolve()));NativeWatcher.prototype.watch=watch;}
}
(async()=>{
 let metrics;
 try {
  if(scenario==='missing-heavy')metrics=await missingHeavy();
  else if(scenario==='method'){
   const binary=path.join(artifact,process.platform==='win32'?'event-cost.exe':'event-cost');
   const p=spawnSync(binary,[fixture],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);
   const data=JSON.parse(p.stdout.trim().split('\n').at(-1));assert.equal(data.files,80000);assert.equal(data.contexts,3000);
   metrics={...data,harnessSha256:hash(binary),memoryScope:"controller-only; sidecar memory not measured"};
  } else metrics=await latency();
  const usage=process.resourceUsage();const result={arm,scenario,rep,platform,arch:process.arch,identity,...metrics,peakMiB:peak(),userCpuMs:(usage.userCPUTime-usageStart.userCPUTime)/1000,systemCpuMs:(usage.systemCPUTime-usageStart.systemCPUTime)/1000};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{clearInterval(sampler);}
})().catch(error=>{console.error(error);process.exitCode=1;});
