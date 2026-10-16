import assert from 'node:assert/strict';
import vm from 'node:vm';
export function topology(source) {
 const start=source.indexOf('if (!rscEnabled) api.onAfterCreateCompiler');
 const end=source.indexOf('if (api.context.action !== "dev" && rscEnabled)',start);
 const logStart=source.indexOf('const logConcurrencyState');
 const logEnd=source.indexOf('if (rscEnabled) api.onAfterCreateCompiler',logStart);
 const results=[];
 const cases=[
  {name:'four independent',want:'engaged mode=default',names:['client','ssr','aux-a','aux-b']},
  {name:'two independent',want:'engaged mode=default',names:['client','ssr']},
  {name:'missing ssr',want:'disengaged reason=topology (names)',names:['client','aux-a']},
  {name:'direct options',want:'disengaged reason=topology (user-dependency)',options:{ssr:['client']}},
  {name:'direct map reverse',want:'disengaged reason=topology (user-dependency)',map:{client:['ssr']}},
  {name:'transitive mixed',want:'disengaged reason=topology (user-dependency)',options:{ssr:['aux-a']},map:{'aux-a':['client']}},
  {name:'transitive reverse',want:'disengaged reason=topology (user-dependency)',map:{client:['aux-b'],'aux-b':['ssr']}},
  {name:'cycle without pair path',want:'engaged mode=default',map:{'aux-a':['aux-b'],'aux-b':['aux-a']}},
  {name:'unrelated edges',want:'engaged mode=default',map:{ssr:['aux-a'],'aux-b':['aux-a'],client:['aux-a']}},
  {name:'other Start server',want:'engaged mode=default',servers:['ssr','aux-b']},
 ];
 for(const test of cases) {
  const names=test.names||['client','ssr','aux-a','aux-b'];
  const compilers=names.map(name=>({name,options:{dependencies:test.options?.[name]},hooks:Object.fromEntries(['thisCompilation','afterEmit','invalid','finishMake','failed','watchClose','afterDone','watchRun','done'].map(k=>[k,{tap(){},tapPromise(){}}]))}));
  const dependencies=new Map(compilers.filter(c=>test.map?.[c.name]).map(c=>[c,[...test.map[c.name]]]));
  const before=new Map([...dependencies].map(([c,v])=>[c,[...v]]));const logs=[];let callback;
  const compiler={compilers,dependencies,setDependencies(c,names){dependencies.set(c,names);}};
  const context={process:{env:{}},api:{context:{action:'dev'},logger:{warn:x=>logs.push(x),info:x=>logs.push(x)},onAfterCreateCompiler:fn=>callback=fn},RSBUILD_ENVIRONMENT_NAMES:{client:'client',server:'ssr'},rscEnabled:false,ssrIsProvider:true,serverFnProviderEnv:'ssr',startCompilerServerEnvironmentNames:test.servers||['ssr'],virtualModuleState:{getResolverWriteRevision:()=>0},coldOverlapMode:undefined,coldAfterMake:false,coldAfterSeal:false,coldAfterEmit:false,coldAfterClientPhase:false,coldOverlap:false,concurrentDev:false,ssrCompiler:undefined,resolverRevision:0,firstClientManifest:undefined,releaseFirstClientManifest:undefined,rejectFirstClientManifest:undefined,firstClientMake:undefined,releaseFirstClientMake:undefined,clientMakeComplete:false,clientManifestPublished:false,beginClientRequestWindow(){},finishClientRequestWindow(){},installClientRequestGate(){},ssrResolverRevision:-1,invalidateSsr(){}};
  vm.runInNewContext(source.slice(logStart,source.includes('let clientRequestWindow;')?source.indexOf('let clientRequestWindow;',logStart):logEnd)+source.slice(start,end),context);callback({compiler});
  assert.equal(logs.length,1,test.name+': one state line');assert.equal(logs[0],'[tss-ssr-concurrency] '+test.want+' gate=on',test.name);
  for(const [c,edges] of before)for(const edge of edges)assert.ok(dependencies.get(c)?.includes(edge),test.name+': map edges preserved');
  for(const c of compilers)assert.deepEqual(c.options.dependencies,test.options?.[c.name],test.name+': user options preserved');
  if(test.servers)assert.equal(JSON.stringify(dependencies.get(compilers.find(c=>c.name==='aux-b'))),'["client"]','other Start server retains stock dependency');
  results.push({name:test.name,passed:true,line:logs[0]});
 }
 return {passed:true,cases:results};
}
