// Observation only: assertions, edit sequence and delivery patch remain unchanged.
import assert from 'node:assert/strict';
export const instrumentJS=original=>{
 let source=original;
 const replace=(old,next)=>{assert.ok(source.includes(old),`JS diagnostic insertion: ${old.slice(0,90)}`);source=source.replace(old,next);};
 replace("const current = new Map();",`const current = new Map();
const diagnostic=[];
const passCounts=new Map();
const captureDir=path.join(out,'capture');fs.mkdirSync(captureDir,{recursive:true});
const paths=items=>[...(items??[])].map(p=>normalize(String(p))).sort();
const state=()=>({active:[...active],pendingInvalid:[...pendingInvalid],compilers:Object.fromEntries([...compilers].map(([name,c])=>[name,{running:c.watching?.running,invalid:c.watching?.invalid}]))});
const observe=(kind,extra={})=>diagnostic.push({step,kind,t:now(),wallMs:Date.now(),...extra});
`);
 replace("compiler.hooks.invalid.tap('WatchInvalidObserver',()=>{pendingInvalid.add(environment.name);event(environment.name,'invalid');});",`compiler.hooks.invalid.tap('WatchInvalidObserver',(file,changeTime)=>{pendingInvalid.add(environment.name);event(environment.name,'invalid',{file:file&&normalize(file),changeTime});observe('invalid',{name:environment.name,file:file&&normalize(file),changeTime,stack:new Error().stack});});
const wfs=compiler.watchFileSystem;
if(wfs?.watch){const watch=wfs.watch;wfs.watch=function(...args){
 observe('watch-attach',{name:environment.name,startTime:args[3]});
 for(const [index,kind] of [[5,'watch-aggregate-callback'],[6,'watch-undelayed-callback']]){const cb=args[index];if(cb)args[index]=function(...values){observe(kind,{name:environment.name,changed:index===5?paths(values[3]):undefined,removed:index===5?paths(values[4]):undefined,file:index===6&&values[0]?normalize(values[0]):undefined,stack:new Error().stack});return cb.apply(this,values);};}
 const watcher=watch.apply(this,args),raw=this.watcher;
 if(raw){
  for(const key of ['_onChange','_onRemove']){const fn=raw[key];if(fn)raw[key]=function(...values){observe('watchpack-'+key,{name:environment.name,args:values.map(v=>typeof v==='string'?normalize(v):v),stack:new Error().stack});return fn.apply(this,values);};}
  raw.on('change',(file,time)=>observe('watch-change',{name:environment.name,file:normalize(file),changeTime:time,stack:new Error().stack}));
  raw.on('aggregated',(changed,removed)=>observe('watch-aggregate',{name:environment.name,changed:paths(changed),removed:paths(removed)}));
 }
 if(watcher?.getInfo){const fn=watcher.getInfo;watcher.getInfo=function(){const info=fn.apply(this,arguments);observe('watch-getInfo',{name:environment.name,changed:paths(info.changes),removed:paths(info.removals)});return info;};}
 return watcher;
};}
compiler.hooks.watchRun.tap({name:'JSPathsObserver',stage:-20000},()=>observe('watchRun-paths',{name:environment.name,modifiedFiles:paths(compiler.modifiedFiles),removedFiles:paths(compiler.removedFiles)}));`);
 replace("const record = { step, name: environment.name, rebuilt: [], built: [], errors: [], modules: {}, assets: [] };",`const pass=(passCounts.get(environment.name)||0)+1;passCounts.set(environment.name,pass);
const record = { step, name: environment.name, pass, modifiedFiles:paths(compiler.modifiedFiles),removedFiles:paths(compiler.removedFiles), rebuilt: [], built: [], errors: [], modules: {}, assets: [] };`);
 replace("for(const asset of compilation.getAssets()) {if(asset.name==='assets/js/index.js')",`if(environment.name==='client'){
 const prefix=step+'-pass-'+record.pass;
 record.capturePrefix=prefix;
 for(const asset of compilation.getAssets().filter(a=>a.name==='assets/js/index.js'||a.name.endsWith('.css'))){
 const file=prefix+'--'+asset.name.replaceAll('/','__');fs.writeFileSync(path.join(captureDir,file),asset.source.buffer());
 }
 observe('assets-captured',{name:environment.name,pass:record.pass,prefix});
}
for(const asset of compilation.getAssets()) {if(asset.name==='assets/js/index.js')`);
 replace("now() - lastEvent >= 1000) return;",`now() - lastEvent >= 1000) {observe('settled',{quietMs:now()-lastEvent,...state(),latestClientPass:builds.filter(b=>b.name==='client').at(-1)?.pass});return;}`);
 replace("clearInterval(timer);\n  if(pageServer)","clearInterval(timer);\n  fs.writeFileSync(path.join(out,'js-diagnostic.json'),JSON.stringify({diagnosticOnly:true,arm,scenario,pid:process.pid,events:diagnostic},null,2));\n  if(pageServer)");
 return source;
};
