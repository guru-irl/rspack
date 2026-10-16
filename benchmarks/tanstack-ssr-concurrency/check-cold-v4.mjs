import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.argv[2],'utf8');
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(mode,concurrent){
 const hook=()=>{const taps=[];return {tap:(o,f)=>taps.push(f),tapPromise:(o,f)=>taps.push(f),call:(...a)=>{for(const f of taps)f(...a);},promise:async(...a)=>{for(const f of taps)await f(...a);}};}; 
 const compiler=name=>({name,options:{},hooks:Object.fromEntries(['thisCompilation','afterEmit','invalid','finishMake','failed','watchClose','afterDone','watchRun','done'].map(k=>[k,hook()]))});
 const client=compiler('client'),ssr=compiler('ssr');let callback;const logs=[];
 const ctx={process:{env:{TSS_SSR_COLD_OVERLAP:mode,TSS_SSR_CONCURRENT:concurrent}},setImmediate,api:{context:{action:'dev'},logger:{warn:x=>logs.push(x),info:x=>logs.push(x)},onAfterCreateCompiler:f=>callback=f},RSBUILD_ENVIRONMENT_NAMES:{client:'client',server:'ssr'},rscEnabled:false,ssrIsProvider:true,serverFnProviderEnv:'ssr',startCompilerServerEnvironmentNames:['ssr'],virtualModuleState:{getResolverWriteRevision:()=>0},beginClientRequestWindow(){},finishClientRequestWindow(){},installClientRequestGate(){}};
 const declarations=source.slice(source.indexOf('let concurrentDev = false;'),source.indexOf('\n\treturn {',source.indexOf('let concurrentDev = false;')));
 const log=source.slice(source.indexOf('const logConcurrencyState'),source.indexOf('let clientRequestWindow;'));
 const start=source.indexOf('if (!rscEnabled) api.onAfterCreateCompiler');
 const code=source.slice(start,source.indexOf('if (api.context.action !== "dev" && rscEnabled)',start));
 vm.runInNewContext(declarations+'\n'+log+'\n'+code,ctx);
 callback({compiler:{compilers:[client,ssr,compiler('aux-a'),compiler('aux-b')],dependencies:new Map(),setDependencies(){}}});
 return {client,ssr,logs,publish:()=>{vm.runInNewContext('clientManifestPublished = true;',ctx);client.hooks.afterDone.call();},compilation:()=>({compiler:client,hooks:{afterSeal:hook()}})};
}
for(const mode of ['after-seal','after-emit']){
 const f=fixture(mode);assert.deepEqual(f.logs,[`[tss-ssr-concurrency] engaged mode=${mode} gate=on`],mode+' parsed');
 let released=false;const waiting=f.ssr.hooks.watchRun.promise().then(()=>released=true);await flush();assert.equal(released,false);
 const child={compiler:{},hooks:{afterSeal:{tap(){throw Error('child compilation tapped');}}}};f.client.hooks.thisCompilation.call(child);
 const compilation=f.compilation();f.client.hooks.thisCompilation.call(compilation);
 f.client.hooks.finishMake.call(compilation);await flush();assert.equal(released,false,mode+' must not start at finishMake');
 compilation.hooks.afterSeal.call();await flush();assert.equal(released,mode==='after-seal',mode+' afterSeal boundary');
 f.client.hooks.afterEmit.call(compilation);await waiting;assert.equal(released,true);
 for(const fallback of ['done','error-done','failed','watchClose','invalid']){
  const g=fixture(mode);let settled=false;const pending=g.ssr.hooks.watchRun.promise().then(()=>settled=true,()=>settled=true);
  await flush();assert.equal(settled,false);
  if(fallback==='done'||fallback==='error-done')g.client.hooks.done.call({hasErrors:()=>fallback==='error-done'});
  else g.client.hooks[fallback].call(new Error('forced client failure'));
  await flush();assert.equal(settled,true,mode+' '+fallback+' releases without trigger');await pending;
 }
 console.log('PASS '+mode+' top-level boundary and done/error/failed/close/invalid fallbacks');
}

for(const [mode,want] of [[undefined,'default'],['0','default'],['1','1'],['after-make','after-make'],['after_seal','default'],['after-emit ','default'],['','default']]){
 const f=fixture(mode);assert.equal(f.logs.at(-1),`[tss-ssr-concurrency] engaged mode=${want} gate=on`);
 if(['after_seal','after-emit ',''].includes(mode))assert.equal(f.logs[0],`[tss-ssr-concurrency] ignored TSS_SSR_COLD_OVERLAP=${mode}`);
 let released=false;const pending=f.ssr.hooks.watchRun.promise().then(()=>released=true);await flush();assert.equal(released,mode==='1');
 const compilation=f.compilation();f.client.hooks.thisCompilation.call(compilation);compilation.hooks.afterSeal.call();f.client.hooks.afterEmit.call(compilation);await flush();assert.equal(released,mode==='1','other modes ignore new phase triggers');
 f.client.hooks.finishMake.call(compilation);await flush();assert.equal(released,mode==='1'||mode==='after-make');
 f.publish();await pending;
}
for(const mode of ['after-seal','after-emit']){
 const f=fixture(mode,'0');assert.deepEqual(f.logs,['[tss-ssr-concurrency] disengaged reason=switch (TSS_SSR_CONCURRENT=0) gate=on']);await f.ssr.hooks.watchRun.promise();
}
console.log('PASS v3 default/after-make/no-barrier, exact-value warnings, CONTROL switch');
