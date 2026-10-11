import assert from 'node:assert/strict';
import vm from 'node:vm';
export async function requestGate(source) {
 // Execute the actual added implementation, with hook doubles only for delivery.
 const a=source.indexOf('let clientRequestWindow;');
 const b=source.indexOf('if (rscEnabled) api.onAfterCreateCompiler',a);
 assert.ok(a>=0&&b>a,'gate implementation present');
 let callback;const calls=[];const taps={};let publish;
 const env={loadBundle:async function(entry){calls.push({entry,self:this===env});return entry;}};
 const ctx={api:{context:{action:'dev'},onBeforeStartDevServer:fn=>callback=fn,onAfterEnvironmentCompile:fn=>publish=typeof fn==='function'?fn:fn.handler},getClientBuild:()=>({}),rscEnabled:false,devServerRef:null,concurrentDev:true,RSBUILD_ENVIRONMENT_NAMES:{server:'ssr',client:'client'}};
 vm.runInNewContext(source.slice(a,b),ctx);
 assert.equal(typeof callback,'function','dev hook registered');
 callback({server:{environments:{ssr:env}}});
 const c=source.indexOf('clientCompiler.hooks.invalid.tap("TanStackStartClientRequestGate"');
 const d=source.indexOf('installClientRequestGate();',c)+'installClientRequestGate();'.length;
 const client={hooks:Object.fromEntries(['invalid','watchRun','done','failed','watchClose'].map(name=>[name,{tap:(options,fn)=>taps[name]=fn}]))};
 ctx.clientCompiler=client;
 vm.runInNewContext(source.slice(c,d),ctx);
 taps.watchRun();
 let resolved=false;const first=env.loadBundle('index').then(()=>resolved=true);
 await Promise.resolve();assert.equal(resolved,false,'request blocks during client window');
 await publish({environment:{name:'client'},stats:{hasErrors:()=>false}});await first;
 assert.equal(calls[0].self,true,'receiver preserved');
 vm.runInNewContext('beginClientRequestWindow();',ctx);
 const second=env.loadBundle('other-entry');await Promise.resolve();assert.equal(calls.length,1,'every entry waits');
 vm.runInNewContext('finishClientRequestWindow();',ctx);assert.equal(await second,'other-entry');
 // A new invalid arriving as an earlier window releases must not leak through.
 vm.runInNewContext('beginClientRequestWindow();',ctx);
 const third=env.loadBundle('index');
 vm.runInNewContext('finishClientRequestWindow();beginClientRequestWindow();',ctx);
 await Promise.resolve();await Promise.resolve();assert.equal(calls.length,2,'renewed window remains blocked');
 vm.runInNewContext('finishClientRequestWindow();',ctx);await third;
 // A newer invalid after the current pass began must survive its publication.
 taps.invalid();taps.watchRun();taps.invalid();
 const newer=env.loadBundle('newer');
 await publish({environment:{name:'client'},stats:{hasErrors:()=>false}});
 await Promise.resolve();assert.equal(calls.length,3,'outdated publication cannot release a newer invalid');
 taps.watchRun();await publish({environment:{name:'client'},stats:{hasErrors:()=>false}});await newer;
 // A client invalid arriving while Rsbuild itself is awaiting SSR must be
 // checked again before the loaded bundle is handed to the caller.
 let finishLoad;const lateEnv={loadBundle:()=>new Promise(resolve=>finishLoad=resolve)};
 callback({server:{environments:{ssr:lateEnv}}});
 let lateReady=false;const late=lateEnv.loadBundle('late').then(()=>lateReady=true);
 await Promise.resolve();taps.invalid();assert.equal(typeof finishLoad,'function');finishLoad('late');
 await Promise.resolve();await Promise.resolve();assert.equal(lateReady,false,'late client invalid keeps request waiting');
 taps.watchRun();await publish({environment:{name:'client'},stats:{hasErrors:()=>false}});await late;
 // Compiler completion is independent of loadBundle: its publication releases
 // without awaiting a pending request. This catches a request/compile cycle.
 for(const event of ['errors','failed','watchClose']) {
  vm.runInNewContext('beginClientRequestWindow();',ctx);
  const pending=env.loadBundle(event);
  if(event==='errors')taps.done({hasErrors:()=>true});else taps[event]();
  assert.equal(await pending,event,event+' releases requests');
 }
 for(const [action,rsc,engaged] of [['build',false,true],['dev',true,false],['dev',false,false]]) {
  let captured;const raw=()=>{};const other={loadBundle:raw};
  const off={...ctx,concurrentDev:engaged,rscEnabled:rsc,api:{context:{action},onBeforeStartDevServer:fn=>captured=fn,onAfterEnvironmentCompile(){}}};
  vm.runInNewContext(source.slice(a,b),off);
  captured?.({server:{environments:{ssr:other}}});
  vm.runInNewContext('installClientRequestGate();',off);
  assert.equal(other.loadBundle,raw,`${action}/${rsc}/${engaged}: no wrapper`);
 }
 return {passed:true,checks:['publication','all entries','receiver','renewed invalid','errors','failed','watchClose','independent completion']};
}
