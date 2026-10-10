import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import v8 from 'node:v8';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { config } from './config.mjs';
import { normalizeRspackClientBuild as normalize } from './normalize-before.mjs';
const root = process.env.BENCH_ROOT;
if (!root) throw Error('BENCH_ROOT required');
const [arm='candidate', label='large', workload='single', mode='speed', rep='0'] = process.argv.slice(2);
const pack = path.join(root, 'packs', arm === 'baseprime' ? 'base' : arm);
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(pack, fs.readdirSync(pack).find(n => n.endsWith('.node')));
const require = createRequire(path.join(root, 'package.json'));
const native = require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
const originalGroupChunks = Object.getOwnPropertyDescriptor(native.ChunkGroup.prototype, 'chunks');
const { rspack, Compilation } = require(path.join(pack, 'dist/index.js'));
const nextJob = () => new Promise(resolve => setImmediate(resolve));
function checkpoint() {
 const heap=v8.getHeapStatistics(), spaces=v8.getHeapSpaceStatistics();
 const mem=process.memoryUsage();
 let anon=0,hwm=0;
 if(process.platform==='linux') {
  const status=fs.readFileSync('/proc/self/status','utf8');
  anon=Number(status.match(/RssAnon:\s+(\d+)/)?.[1]||0)*1024;
  hwm=Number(status.match(/VmHWM:\s+(\d+)/)?.[1]||0)*1024;
 }
 return {used:heap.used_heap_size,old:spaces.find(s=>s.space_name==='old_space').space_used_size,external:heap.external_memory,arrayBuffers:mem.arrayBuffers,rss:mem.rss,anon,hwm};
}
function host() {
 const available=process.platform==='linux' ? Number(fs.readFileSync('/proc/meminfo','utf8').match(/MemAvailable:\s+(\d+)/)[1])*1024 : os.freemem();
 const load=os.loadavg()[0];
 if(process.platform==='linux' && (load>=4 || available<8*1024**3)) throw Error(`Host gate: load ${load}, available ${available}`);
 return {load,available};
}
function serialize(value) {return JSON.stringify([value.entryChunkFileName,[...value.chunksByFileName],value.cssContentByFileName]);}
function hash(value) {
 // Parallel baseline builds do not promise manifest Map or sibling traversal order.
 // Canonicalize only the diagnostic checksum, never values consumed in the timed tap.
 const chunks=[...value.chunksByFileName].map(([key,item])=>[key,{...item,imports:[...item.imports].sort(),dynamicImports:[...item.dynamicImports].sort(),css:[...item.css].sort(),routeFilePaths:[...item.routeFilePaths].sort(),hydrationIds:[...item.hydrationIds].sort()}]).sort(([a],[b])=>a.localeCompare(b));
 return crypto.createHash('sha256').update(JSON.stringify([value.entryChunkFileName,chunks,value.cssContentByFileName])).digest('hex');
}
function uncached(compilation) {
 const saved=[];
 for(const [proto,key,get] of [[native.Chunk.prototype,'files',function(){return new Set(this._files);}],[native.Chunk.prototype,'groupsIterable',function(){return new Set(this._groupsIterable);}],[native.ChunkGroup.prototype,'chunks',originalGroupChunks.get]]) {
  const descriptor=Object.getOwnPropertyDescriptor(proto,key);saved.push([proto,key,descriptor]);Object.defineProperty(proto,key,{...descriptor,get});
 }
 try{return normalize(compilation);}finally{for(const [proto,key,descriptor] of saved)Object.defineProperty(proto,key,descriptor);}
}
let observedPeak=checkpoint(), sink=0;
function observe(){const now=checkpoint();for(const key of Object.keys(now))observedPeak[key]=Math.max(observedPeak[key],now[key]);}
function instrument() {
 const changes=[];
 for(const [proto,key] of [[native.Chunk.prototype,'files'],[native.Chunk.prototype,'groupsIterable'],[native.Chunk.prototype,'auxiliaryFiles'],[native.ChunkGroup.prototype,'chunks'],[native.ChunkGroup.prototype,'childrenIterable']]) {
  const desc=Object.getOwnPropertyDescriptor(proto,key);
  if(!desc?.get)throw Error(`Missing ${key}`);
  Object.defineProperty(proto,key,{...desc,get(){observe();const out=desc.get.call(this);observe();return out;}});
  changes.push([proto,key,desc]);
 }
 return ()=>{for(const [proto,key,desc] of changes)Object.defineProperty(proto,key,desc);};
}
const result={arm,label,workload,mode,rep,node:process.version,platform:process.platform,startHost:host(),members:[]};
const expected=label==='small'?[760,481]:[3245,3101];
const count=workload==='multi'?2:1;
const configs=[];
const postJobs=[];
for(let member=0;member<count;member++) {
 const item={member,tapSamples:[]};result.members.push(item);
 const plugin={apply(compiler){compiler.hooks.thisCompilation.tap('CollectionBenchmark',compilation=>{
  const pattern=!['no-reader','read-once','churn'].includes(workload);
  if(mode==='speed'&&pattern) for(let n=0;n<8;n++) compilation.hooks.processAssets.tap({name:`Warmup${n}`,stage:Compilation.PROCESS_ASSETS_STAGE_REPORT-1},()=>{const value=normalize(compilation);sink+=value.chunksByFileName.size;});
  for(let trial=0;trial<(mode==='speed'&&pattern?9:1);trial++) compilation.hooks.processAssets.tap({name:`CollectionBenchmark${trial}`,stage:Compilation.PROCESS_ASSETS_STAGE_REPORT},()=>{
   item.chunks=[...compilation.chunks].length;item.groups=compilation.chunkGroups.length;
   if(item.chunks!==expected[0]||item.groups!==expected[1])throw Error(`Unexpected shape ${item.chunks}/${item.groups}`);
   if(mode==='speed') {
    const start=performance.now();
    let value;
    if(workload==='no-reader') sink+=item.chunks;
    else if(workload==='read-once') {for(const chunk of compilation.chunks){sink+=chunk.files.size+chunk.groupsIterable.size;}for(const group of compilation.chunkGroups)sink+=group.chunks.length;}
    else if(workload==='churn') {
     const chunk=[...compilation.chunks][0];
     const file=[...chunk.files][0];let current=file;
     for(let n=0;n<32;n++){sink+=chunk.files.size;const next=`churn-${n}.js`;compilation.renameAsset(current,next);sink+=chunk.files.size;current=next;}
     compilation.renameAsset(current,file);
    } else value=normalize(compilation);
    const elapsed=performance.now()-start;item.tapSamples.push(elapsed);
    if(value){item.hash=hash(value);sink+=value.chunksByFileName.size;
     if(trial===8){const fresh=uncached(compilation);if(serialize(value)!==serialize(fresh))throw Error('cached/uncached ordered output differs on same graph');item.exactParity=true;}
    }
   } else {
    global.gc();item.pre=checkpoint();observedPeak={...item.pre};
    const restore=instrument();
    try {
     if(workload!=='no-reader'){const value=normalize(compilation);item.hash=hash(value);sink+=value.chunksByFileName.size;}
     observe();item.peak={...observedPeak};
    } finally {restore();}
   }
  });
  if(mode!=='speed') compilation.hooks.afterProcessAssets.tap('CollectionMemoryPost',()=>{
   postJobs.push(nextJob().then(()=>{global.gc();item.post=checkpoint();}));
  });
 });}};
 const c=config(label,plugin);
 c.name=member===0?'client':'server';
 c.output={...c.output,path:path.join(root,'outputs',`${arm}-${label}-${workload}-${mode}-${rep}-${member}`)};
 configs.push(c);
}
let compiler=rspack(count===1?configs[0]:configs);
const build=()=>new Promise((resolve,reject)=>compiler.run((error,stats)=>{
 if(error||stats?.hasErrors())reject(error||Error(stats.toString({all:false,errors:true})));
 else resolve();
}));
const started=performance.now();await build();result.buildMs=performance.now()-started;
await Promise.all(postJobs);
if(mode==='rebuild') {
 result.rebuilds=[];
 for(let n=0;n<2;n++){await nextJob();await build();await nextJob();global.gc();result.rebuilds.push(checkpoint());}
}
await nextJob();global.gc();result.idle=checkpoint();
await new Promise((resolve,reject)=>compiler.close(error=>error?reject(error):resolve()));
compiler=null;
await nextJob();global.gc();await nextJob();global.gc();result.end=checkpoint();
result.endHost=host();result.sink=sink;
fs.mkdirSync(path.join(root,'results'),{recursive:true});
const output=path.join(root,'results',`${label}-${workload}-${mode}-${rep}-${arm}.json`);
fs.writeFileSync(output,JSON.stringify(result,null,2));
console.log(JSON.stringify({output,buildMs:result.buildMs,members:result.members.map(m=>({tapMs:[...m.tapSamples].sort((a,b)=>a-b)[Math.floor(m.tapSamples.length/2)],hash:m.hash,chunks:m.chunks,groups:m.groups})),endHost:result.endHost}));
