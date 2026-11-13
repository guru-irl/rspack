const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const [repoArg, label, mode, nArg, out] = process.argv.slice(2);
const repo = fs.realpathSync(repoArg), count = Number(nArg);
assert(Number.isInteger(count) && count > 0);
const pin = fs.realpathSync.native(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
const hash = crypto.createHash('sha256').update(fs.readFileSync(pin)).digest('hex');
assert.equal(hash, process.env.EXPECTED_BINDING_SHA256);
let loaded = false;
const dlopen = process.dlopen;
process.dlopen = function(module, filename, ...args) { const result = dlopen.call(this,module,filename,...args); if(fs.realpathSync.native(filename)===pin)loaded=true; return result; };
const { NativeWatcher } = require(pin);
assert(loaded);
if(process.platform==='linux')assert(fs.readFileSync('/proc/self/maps','utf8').includes(pin));
console.log(JSON.stringify({type:'identity',label,sha:hash,binding:pin,proof:process.platform==='linux'?'maps':'dlopen'}));
const wait = ms => new Promise(r => setTimeout(r,ms));
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR,'watch-cost-')));
const ctx = path.join(root,'ctx'), ready = path.join(root,'index.js');
const past = new Date(Date.now()-15000);
fs.writeFileSync(ready,'0');fs.utimesSync(ready,past,past);
for(let i=0;i<count;i++){const dir=path.join(ctx,'d'+i);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'seed.txt');fs.writeFileSync(file,'0');fs.utimesSync(file,past,past);}
const errors=[];
let watcher, rewatched=false;
const start=performance.now();
if(mode==='native'){
 watcher=new NativeWatcher({aggregateTimeout:20,followSymlinks:true});
 watcher.watch([[ready],[]],[[ctx],[]],[[],[]],BigInt(Date.now()),error=>{if(error)errors.push(String(error));},()=>{});
}else{
 const Watchpack=require(path.join(repo,'packages/rspack/compiled/watchpack'));
 watcher=new Watchpack({aggregateTimeout:20,followSymlinks:true});watcher.watch({files:[ready],directories:[ctx],missing:[],startTime:Date.now()});
}
const entries=()=>mode==='native'?watcher.collectTimeInfoEntries().fileTimestamps.entries:new Map(watcher.getTimeInfoEntries());
const seeds=()=>mode==='native'?entries().filter(e=>e.path.endsWith('seed.txt')).length:[...entries().keys()].filter(p=>p.endsWith('seed.txt')).length;
(async()=>{
 try{
  const deadline=Date.now()+120000;
  while(seeds()<count && Date.now()<deadline)await wait(50);
  assert.equal(seeds(),count,'Scan did not finish');
  const setupMs=performance.now()-start;
  await wait(300);if(global.gc)global.gc();
  const peakRssKiB=process.resourceUsage().maxRSS,steadyRssBytes=process.memoryUsage.rss();
  console.error('REWATCH_BEGIN');
  if(mode==='native'){
   watcher.watch([[],[]],[[],[]],[[],[]],BigInt(Date.now()),(error)=>{if(error)errors.push(String(error));rewatched=true;},()=>{});
   fs.writeFileSync(ready,'1');
   const deadline=Date.now()+5000;
   while(!rewatched&&Date.now()<deadline)await wait(20);
   assert(rewatched,'Unchanged-dependency rewatch did not apply');
  }
  console.error('REWATCH_END');
  const receipt={type:'cost',label,mode,count,seeds:seeds(),setupMs,peakRssKiB,steadyRssBytes,errors,sha:hash};
  fs.writeFileSync(out,JSON.stringify(receipt));console.log(JSON.stringify(receipt));
  assert.equal(errors.length,0);
 }finally{await watcher.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
