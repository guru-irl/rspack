// Diagnosis only. No delivery patch or ordinary correctness assertions change.
import assert from 'node:assert/strict';
import { instrumentCSS } from './instrument-css.mjs';
export const instrumentResponse=original=>{
 let source=instrumentCSS(original);
 const replace=(old,next)=>{assert.ok(source.includes(old),`response diagnostic insertion: ${old.slice(0,80)}`);source=source.replace(old,next);};
 replace("import fs from 'node:fs';", "import fs from 'node:fs';\nimport { AsyncLocalStorage } from 'node:async_hooks';\nimport { syncBuiltinESMExports } from 'node:module';");
 replace("const current = new Map();",`const current = new Map();
const diagnostic=[];
const requestContext=new AsyncLocalStorage();
const linkedChecks=[];
const pendingInvalid=new Set();
const manifests=new Map();
const manifestCache=new WeakMap();
let requestNumber=0;
let publishedManifest;
const serial=v=>JSON.parse(JSON.stringify(v??null));
const clientState=()=>{
 const c=compilers.get('client'),w=c?.watching;
 return {state:active.has('client')?'compiling':pendingInvalid.has('client')?'invalid pending':'idle',active:[...active],invalidPending:pendingInvalid.has('client'),watchingRunning:w?.running,watchingInvalid:w?.invalid,compilerIdle:c?.idle,latestHash:builds.filter(b=>b.name==='client').at(-1)?.hash,compilationHash:c?._lastCompilation?.hash};
};
const emitDiagnostic=(kind,extra={})=>diagnostic.push({kind,step,t:performance.now(),wallMs:Date.now(),pid:process.pid,request:requestContext.getStore(),client:clientState(),...extra});
const manifestInfo=value=>{
 if(value==null)return {manifestSHA256:null};
 if(manifestCache.has(value))return manifestCache.get(value);
 const json=JSON.stringify(value),sha=hash(json);if(!manifests.has(sha))manifests.set(sha,serial(value));
 const info={manifestSHA256:sha,routeCSS:routeCSS([value.routes?.__root__,value.routes?.['/']])};manifestCache.set(value,info);return info;
};
Object.defineProperty(globalThis,'__TSS_DEV_START_MANIFEST__',{configurable:true,get(){emitDiagnostic('manifest-read',{...manifestInfo(publishedManifest),stack:new Error().stack});return publishedManifest;},set(value){publishedManifest=value;emitDiagnostic('manifest-publication',manifestInfo(value));}});
globalThis.__responseDiagnostic=(kind,extra)=>emitDiagnostic(kind,{...manifestInfo(publishedManifest),...extra});
const stack=()=>new Error().stack;
const diagnosticFile=p=>typeof p==='string'&&(path.resolve(p).startsWith(path.join(process.cwd(),'src'))||path.resolve(p).startsWith(path.join(process.cwd(),'aux'))||p.includes('_tanstack-start'));
for(const key of ['writeFileSync','renameSync','unlinkSync']){
 const fn=fs[key];fs[key]=function(...args){if(diagnosticFile(args[0]))emitDiagnostic('fs-'+key,{file:normalize(path.resolve(String(args[0]))),destination:key==='renameSync'?normalize(path.resolve(String(args[1]))):undefined,contentSHA256:key==='writeFileSync'?hash(args[1]):undefined,stack:stack()});return fn.apply(this,args);};
}
for(const key of ['writeFile','rename','unlink']){
 const fn=fs.promises[key];fs.promises[key]=function(...args){if(diagnosticFile(String(args[0])))emitDiagnostic('fs-promises-'+key,{file:normalize(path.resolve(String(args[0]))),destination:key==='rename'?normalize(path.resolve(String(args[1]))):undefined,stack:stack()});return fn.apply(this,args);};
}
syncBuiltinESMExports();
const wrapBundle=bundle=>{
 const wrapHandler=handler=>new Proxy(handler,{apply(fn,receiver,args){emitDiagnostic('render-start',manifestInfo(publishedManifest));return Reflect.apply(fn,receiver,args);}});
 return new Proxy(bundle,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);if(key!=='default')return value;if(typeof value==='function')return wrapHandler(value);if(value&&typeof value.fetch==='function')return new Proxy(value,{get(t,k,r){const v=Reflect.get(t,k,r);return k==='fetch'?wrapHandler(v):v;}});return value;}});
};
const observeServer=server=>{
 assert.ok(Array.isArray(server.middlewares.stack),'Connect middleware stack available for observation');
 server.middlewares.stack.unshift({route:'',handle:(req,res,next)=>requestContext.run({id:++requestNumber,path:req.url,pagePath:'middleware'},()=>{emitDiagnostic('request-arrival',manifestInfo(publishedManifest));res.once('finish',()=>emitDiagnostic('response-end',{status:res.statusCode,...manifestInfo(publishedManifest)}));next();})});
 const env=server.environments.ssr,load=env.loadBundle;
 env.loadBundle=async function(...args){emitDiagnostic('loadBundle-enter',{entry:args[0],...manifestInfo(publishedManifest)});const b=await load.apply(this,args);emitDiagnostic('inner-loadBundle-return',{entry:args[0],...manifestInfo(publishedManifest)});return wrapBundle(b);};
};
const linkedURLs=html=>[...new Set([...html.matchAll(/(?:href|src)="([^"]+\\.(?:css|js)(?:[?#][^"]*)?)"/g)].map(m=>m[1]))].sort();
const fetchLinked=async(label,html)=>{
 const client=builds.filter(b=>b.name==='client').at(-1);
 const records=[];
 for(const url of linkedURLs(html)){
  const absolute=new URL(url,'http://localhost:3100');if(absolute.port==='3101')absolute.port='3100';
  const r=await fetch(absolute,{signal:AbortSignal.timeout(15000)}),bytes=Buffer.from(await r.arrayBuffer());
  const key=decodeURIComponent(absolute.pathname).replace(/^\\//,'');
  const expected=client?.diagnosticAssets?.find(a=>a.name===key);
  const prior=builds.filter(b=>b.name==='client'&&b!==client).flatMap(b=>b.diagnosticAssets??[]).filter(a=>a.name===key);
  records.push({url,status:r.status,sha256:hash(bytes),bytes:bytes.length,expectedSHA256:expected?.sha256,matchesCurrent:r.status===200&&hash(bytes)===expected?.sha256,priorSHAs:[...new Set(prior.map(a=>a.sha256))],editedCSS:/generic-(?:new-)?request/.test(bytes.toString())?/color: #505050/.test(bytes.toString()):undefined});
 }
 const result={label,step,t:performance.now(),pagePath:customWindow?'custom-server':'middleware',client:clientState(),manifest:manifestInfo(publishedManifest),records};linkedChecks.push(result);
 fs.writeFileSync(path.join(out,'linked-assets.json'),JSON.stringify(linkedChecks,null,2));return result;
};`);
 replace("const timer = measuring ? undefined : setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);", "const timer = undefined; // No memory sampling in diagnosis.");
 replace("const event = (name, kind, extra = {}) => {", "const event = (name, kind, extra = {}) => { if(name==='client'){if(kind==='invalid')pendingInvalid.add(name);if(kind==='watchRun')pendingInvalid.delete(name);} emitDiagnostic('compiler-'+kind,{name,...extra});");
 replace("api.onBeforeStartDevServer(({server})=>{hookEnvironment=server.environments.ssr;});", "api.onBeforeStartDevServer(({server})=>{hookEnvironment=server.environments.ssr;observeServer(server);});");
 replace("config.plugins.push({ apply(compiler) {", `for(const p of config.plugins)if(typeof p.writeModule==='function'){
 const write=p.writeModule;p.writeModule=function(file,content){emitDiagnostic('virtual-write',{environment:environment.name,plugin:p.constructor.name,file:normalize(file),contentSHA256:hash(content),stack:stack()});return write.apply(this,arguments);};
 }
 config.plugins.push({ apply(compiler) {`);
 replace("compiler.hooks.invalid.tap('WatchInvalidObserver',()=>event(environment.name,'invalid'));", `compiler.hooks.invalid.tap('WatchInvalidObserver',(file,changeTime)=>event(environment.name,'invalid',{file:file&&normalize(file),changeTime,stack:stack()}));
 const wfs=compiler.watchFileSystem;
 if(wfs?.watch){const watch=wfs.watch;wfs.watch=function(...args){
 const watcher=watch.apply(this,args);const raw=this.watcher;
 if(raw?.on){raw.on('change',(file,time)=>emitDiagnostic('watch-change',{name:environment.name,file:normalize(file),changeTime:time}));raw.on('remove',file=>emitDiagnostic('watch-remove',{name:environment.name,file:normalize(file)}));raw.on('aggregated',(changed,removed)=>emitDiagnostic('watch-aggregate',{name:environment.name,changed:[...(changed??[])].map(normalize),removed:[...(removed??[])].map(normalize)}));}
 if(watcher?.getInfo){const get=watcher.getInfo;watcher.getInfo=function(){const info=get.apply(this,arguments);emitDiagnostic('watch-getInfo',{name:environment.name,changed:[...(info.changes??[])].map(normalize),removed:[...(info.removals??[])].map(normalize)});return info;};}return watcher;
 };}
 compiler.hooks.watchRun.tap({name:'ResponseDiagnosticPaths',stage:-20000},()=>emitDiagnostic('watchRun-paths',{name:environment.name,modifiedFiles:[...(compiler.modifiedFiles??[])].map(normalize),removedFiles:[...(compiler.removedFiles??[])].map(normalize)}));`);
 replace("if(environment.name==='client') {", "if(environment.name==='client') {\n  record.diagnosticAssets=compilation.getAssets().filter(a=>/\\.(css|js)$/.test(a.name)).map(a=>({name:a.name,sha256:hash(a.source.buffer()),bytes:a.source.size()}));");
 replace("windowEvidence.status=r.status;", "emitDiagnostic('window-fetch-response-end',manifestInfo(publishedManifest));windowEvidence.responseEnded=now();windowEvidence.status=r.status;");
 replace("windowEvidence.css=[...html.matchAll", "windowEvidence.linkedURLs=linkedURLs(html);windowEvidence.css=[...html.matchAll");
 replace("assert.ok(windowEvidence.css.every(url=>next.includes(url)),'window HTML has no stale or replaced CSS link');", `windowEvidence.withinArmLiteralMatch=windowEvidence.css.every(url=>next.includes(url));
 windowEvidence.diagnosticOnly=true;
 windowEvidence.linkedAfterSettlement=await fetchLinked('request-window',fs.readFileSync(path.join(out,'request-window.html'),'utf8'));
 fs.writeFileSync(path.join(out,'request-window.json'),JSON.stringify(windowEvidence,null,2));`);
 // These assertions are observed, not revised, only in this diagnostic runtime copy.
 replace("assert.ok(expectedCSS.some(url=>!previous.includes(url)),'stock route manifest requires the NEW CSS asset');", "windowEvidence.stockRequiresNewCSS=expectedCSS.some(url=>!previous.includes(url));");
 replace("const response = await fetch(\u0060http://localhost:3100${route}\u0060);", "const response = await fetch(\u0060http://localhost:${customWindow?3101:3100}${route}\u0060);");
 replace("fs.writeFileSync(path.join(out, \u0060${step}-${route.replaceAll('/', '_')}.html\u0060), html);", "fs.writeFileSync(path.join(out, \u0060${step}-${route.replaceAll('/', '_')}.html\u0060), html);\n if(!process.env.RESPONSE_WINDOW_ONLY)await fetchLinked(route,html);");
 replace("pageServer=createServer(async(req,res)=>{", "pageServer=createServer((req,res)=>requestContext.run({id:++requestNumber,path:req.url,pagePath:'custom-server'},async()=>{\n emitDiagnostic('request-arrival',manifestInfo(publishedManifest));res.once('finish',()=>emitDiagnostic('response-end',{status:res.statusCode,...manifestInfo(publishedManifest)}));");
 replace("} catch(error) {console.error(error);res.statusCode=500;res.end(String(error));}\n    });", "} catch(error) {console.error(error);res.statusCode=500;res.end(String(error));}\n    }));");
 replace("const customWindow=scenario==='r3-custom-request';", "const customWindow=process.env.DIAGNOSTIC_PAGE_PATH==='custom-server';");
 replace("clearInterval(timer);\n  if(pageServer)", "clearInterval(timer);\n   fs.writeFileSync(path.join(out,'response-diagnostic.json'),JSON.stringify({diagnosticOnly:true,pagePath:customWindow?'custom-server':'middleware',events:diagnostic,manifests:Object.fromEntries(manifests)},null,2));\n   if(pageServer)");
 if(process.env.RESPONSE_WINDOW_ONLY){
 const a=source.indexOf("       for(const kind of ['add','rename','remove','body'])");
 const final="await waitIdle(2); await sample(base,'Public leaf baseline');";
 const b=source.indexOf(final,a)+final.length;
 assert.ok(a>=0&&b>a,'diagnostic window stop boundaries');
 source=source.slice(0,a)+'       if(!process.env.RESPONSE_WINDOW_ONLY){\n'+source.slice(a,b)+'\n       }'+source.slice(b);
 }
 replace("else fs.writeFileSync('aux/request.css','.generic-request { color: rgb(80, 80, 80); }\\n');", "else fs.writeFileSync('aux/request.css','.generic-request { color: rgb(80, 80, 80); }\\n');\n const editedFile=customWindow?'aux/request-entry.js':'aux/request.css';const editedStat=fs.statSync(editedFile);emitDiagnostic('fixture-write-complete',{file:normalize(path.resolve(editedFile)),mtimeMs:editedStat.mtimeMs,ctimeMs:editedStat.ctimeMs,size:editedStat.size});");
 return source;
};
export const instrumentGate=source=>source.replace('release?.();','globalThis.__responseDiagnostic?.("gate-release",{clientRequestRevision,compilingClientRequestRevision});\n\t\t\t\trelease?.();').replace('return bundle;','globalThis.__responseDiagnostic?.("outer-loadBundle-return",{clientRequestRevision,compilingClientRequestRevision});\n\t\t\t\t\treturn bundle;');
