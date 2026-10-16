import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {requestGate} from './check-request-gate.mjs';
const root=process.cwd(),fixture=path.join(root,'benchmarks/tanstack-ssr-concurrency');
const work=process.env.WORK_DIR,app=path.join(work,'app'),pkg=path.join(app,'node_modules/@tanstack/start-plugin-core'),dist=path.join(pkg,'dist/esm/rsbuild');
const v3Patch=process.env.PATCH_FILE;
const originals=Object.fromEntries(['plugin.js','virtual-modules.js'].map(f=>[f,fs.readFileSync(path.join(work,'pristine/dist/esm/rsbuild',f),'utf8')]));
const v3=Object.fromEntries(['plugin.js','virtual-modules.js'].map(f=>[f,fs.readFileSync(path.join(work,'v4/dist/esm/rsbuild',f),'utf8')]));
const execute=(arm,scenario,index)=>{
 const result=path.join(work,`${scenario}-${index}-${arm}`); fs.mkdirSync(result,{recursive:true});
 for(const [f,text] of Object.entries(originals)) fs.writeFileSync(path.join(dist,f),text);
 if(arm!=='stock') {
  const patchFile=v3Patch;
  const apply=spawnSync('patch',['--batch','--fuzz=0','-p1','-i',patchFile],{cwd:pkg,encoding:'utf8'});
  fs.writeFileSync(path.join(result,'patch-apply.log'),apply.stdout+apply.stderr); assert.equal(apply.status,0,'pristine dist patch applies');assert.ok(!/offset|fuzz|FAILED/i.test(apply.stdout+apply.stderr),'clean apply without offsets or fuzz');
 }
 const expected=arm==='stock'?{ 'plugin.js':'c892ae8404c1e30a2f409fcf1890713453fd465b9a515a5d5a8e685160d1e63b','virtual-modules.js':'8b1aca7c277767ae7a84cb63057b34d4e2dc1b7b90e150a2bb9cf47a4c3bc8a6' }:Object.fromEntries(Object.entries(arm==='v2'?Object.fromEntries(['plugin.js','virtual-modules.js'].map(f=>[f,fs.readFileSync(path.join(generatedRoot,f),'utf8')])):v3).map(([f,text])=>[f,crypto.createHash('sha256').update(text).digest('hex')]));
 for(const file of ['plugin.js','virtual-modules.js']) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,file))).digest('hex'),expected[file],`${file}: pristine/patched output byte-for-byte hash`);
  const checked=spawnSync('node',['--check',path.join(dist,file)],{encoding:'utf8'});
  fs.writeFileSync(path.join(result,`${file}-syntax.log`),checked.stdout+checked.stderr);assert.equal(checked.status,0,`${file}: syntax`);
  fs.copyFileSync(path.join(dist,file),path.join(result,`unobserved-${file}`));
 }
 // Observation only: preserve the real virtual module object and all decisions.
 let plugin=fs.readFileSync(path.join(dist,'plugin.js'),'utf8');
 plugin=plugin.replace('updateServerFnResolver = virtualModuleState.updateServerFnResolver;','updateServerFnResolver = virtualModuleState.updateServerFnResolver;\n globalThis.__watchVirtualState = virtualModuleState;');
 if(process.env.MODE?.startsWith('r3-response-'))plugin=instrumentGate(plugin);
 if(scenario==='v4-cold-request')plugin=plugin.replace('globalThis.__watchVirtualState = virtualModuleState;', 'globalThis.__watchVirtualState = virtualModuleState; const publishManifest = virtualModuleState.updateManifest; virtualModuleState.updateManifest = function(...args) { const result=publishManifest.apply(this,args); (globalThis.__v4ManifestEvents ??= []).push(performance.now()); return result; };');
 fs.writeFileSync(path.join(dist,'plugin.js'),plugin);
 fs.rmSync(path.join(app,'src'),{recursive:true,force:true}); fs.rmSync(path.join(app,'dist'),{recursive:true,force:true});
 fs.cpSync(path.join(root,'benchmarks/tanstack-topology/src'),path.join(app,'src'),{recursive:true});
 fs.writeFileSync(path.join(app,'src/Page.tsx'),`import * as functions from './functions';\nimport { Leaf } from './Leaf';\nimport { useState, useEffect } from 'react';\nexport function Page({ title }) { const [data,setData]=useState(null); useEffect(()=>{},[]); return <main><h1>{title}</h1><Leaf /><pre>{JSON.stringify(data)}</pre></main>; }\n`);
 // Route loaders use real server functions; lazy components supply route-split assets.
 const route=(url,title)=>`import { createFileRoute } from '@tanstack/react-router';\nimport * as functions from '../functions';\nimport { Leaf } from '../Leaf';\nexport const Route=createFileRoute('${url}')({ loader:async()=>Object.fromEntries(await Promise.all(Object.entries(functions).sort(([a],[b])=>a.localeCompare(b)).map(async([name,fn])=>[name,await fn()]))), component:Home });\nfunction Home(){const data=Route.useLoaderData();return <main><h1>${title}</h1><Leaf /><pre>{JSON.stringify(data)}</pre></main>}\n`;
 fs.writeFileSync(path.join(app,'src/routes/index.tsx'),route('/','Generic home'));
 for(let i=1;i<=60;i++){const n=String(i).padStart(3,'0');fs.writeFileSync(path.join(app,`src/routes/page-${n}.tsx`),route(`/page-${n}`,`Page ${n}`));}
 // The added route shares the same working loader/component contract.
 fs.writeFileSync(path.join(app,'src/Page.tsx'),`import { useLoaderData } from '@tanstack/react-router';\nimport { Leaf } from './Leaf';\nexport function Page({title}) { const data=useLoaderData({strict:false}); return <main><h1>{title}</h1><Leaf /><pre>{JSON.stringify(data)}</pre></main>; }\n`);
 fs.writeFileSync(path.join(app,'src/no-resolver.ts'),'export default {fetch:async()=>new Response("generic custom entry")};\n');
 fs.writeFileSync(path.join(app,'src/extra.css'),'.generic-extra { color: rgb(20, 20, 20); }\n');
 fs.mkdirSync(path.join(app,'aux'),{recursive:true});
  fs.writeFileSync(path.join(app,'aux/request-entry.js'),'export {};\n');
  fs.writeFileSync(path.join(app,'aux/new-request.css'),'.generic-new-request { color: rgb(80, 80, 80); }\n');
  fs.writeFileSync(path.join(app,'aux/request.css'),'.generic-request { color: rgb(20, 20, 20); }\n');
  for(const name of ['aux-a','aux-b'])fs.writeFileSync(path.join(app,'aux',`${name}.js`),`document.body.textContent = 'Generic ${name}';\n`);
  if(process.env.MODE?.startsWith('r3-response-'))fs.writeFileSync(path.join(app,'run.mjs'),instrumentResponse(fs.readFileSync(path.join(fixture,'run.mjs'),'utf8')));
   else if(process.env.MODE==='r3-css-diagnosis')fs.writeFileSync(path.join(app,'run.mjs'),instrumentCSS(fs.readFileSync(path.join(fixture,'run.mjs'),'utf8')));
  else if(process.env.MODE==='r3-js-diagnosis')fs.writeFileSync(path.join(app,'run.mjs'),instrumentJS(fs.readFileSync(path.join(fixture,'run.mjs'),'utf8')));
 else if(process.env.MODE==='r3-restart-diagnosis')fs.writeFileSync(path.join(app,'run.mjs'),instrumentRestart(fs.readFileSync(path.join(fixture,'run.mjs'),'utf8')));
 else fs.copyFileSync(path.join(fixture,'run-v4.mjs'),path.join(app,'run.mjs'));
 fs.copyFileSync(path.join(fixture,'trigger-capture.mjs'),path.join(app,'trigger-capture.mjs'));
 fs.copyFileSync(path.join(fixture,'runtime-css.mjs'),path.join(app,'runtime-css.mjs'));
 fs.copyFileSync(path.join(fixture,'restart-shutdown.mjs'),path.join(app,'restart-shutdown.mjs'));
 fs.copyFileSync(path.join(work,'pregenerated-routeTree.ts'),path.join(app,'src/routeTree.gen.ts'));
 if(scenario==='production') {
  fs.copyFileSync(path.join(fixture,'run-production.mjs'),path.join(app,'run-production.mjs'));
  const run=spawnSync('node',['run-production.mjs'],{cwd:app,env:{...process.env,NODE_ENV:'production',RESULT_DIR:result,TSS_SSR_CONCURRENT:arm==='gate-only'?'0':'1',TSS_SSR_COLD_OVERLAP:['after-make','after-seal','after-emit'].includes(arm)?arm:'0'},encoding:'utf8',timeout:600000});
  fs.writeFileSync(path.join(result,'console.log'),run.stdout+run.stderr);
  fs.writeFileSync(path.join(result,'exit.json'),JSON.stringify({status:run.status,signal:run.signal}));
  assert.ok(!/\[tss-ssr-concurrency\]/.test(run.stdout+run.stderr),'no production concurrency logs');
  return {result,status:run.status};
 }
 const run=spawnSync((process.env.MODE?.startsWith('r3-response-')||process.env.MODE==='r3-js-diagnosis')?'node':'/usr/bin/time',(process.env.MODE?.startsWith('r3-response-')||process.env.MODE==='r3-js-diagnosis')?['run.mjs']:['-v','-o',path.join(result,'process-time.txt'),'python3',path.join(fixture,'measure-process.py')],{cwd:app,env:{...process.env,NODE_ENV:'development',RESULT_DIR:result,ARM:arm,SCENARIO:scenario,STOCK_REQUEST_EXPECTATION:path.join(work,`stock-request-${process.env.COMPILER_COUNT||'2'}-${scenario}.json`),TSS_SSR_CONCURRENT:arm==='gate-only'?'0':arm==='invalid-switch'?'true':'1',TSS_SSR_COLD_OVERLAP:arm==='overlap'?'1':['after-make','after-seal','after-emit'].includes(arm)?arm:arm==='invalid-mode'?'after_make':'0'},encoding:'utf8',timeout:180000});
 fs.writeFileSync(path.join(result,'console.log'),run.stdout+run.stderr);
 fs.writeFileSync(path.join(result,'exit.json'),JSON.stringify({status:run.status,signal:run.signal,error:run.error?.message}));
 if(run.status===0 && arm!=='stock' && arm!=='v2') {
  const log=fs.readFileSync(path.join(result,(process.env.MODE?.startsWith('r3-response-')||process.env.MODE==='r3-js-diagnosis')?'console.log':'node-console.log'),'utf8');
  const state=arm==='gate-only'?'disengaged reason=switch (TSS_SSR_CONCURRENT=0)':process.env.USER_EDGES?'disengaged reason=topology (user-dependency)':scenario==='r2-topology'?'disengaged reason=topology (user-dependency)':arm==='gate-only'?'disengaged reason=switch (TSS_SSR_CONCURRENT=0)':`engaged mode=${['after-make','after-seal','after-emit'].includes(arm)?arm:arm==='overlap'?'1':'default'}`;
  assert.equal(log.split(`[tss-ssr-concurrency] ${state} gate=on`).length-1,scenario==='r2-restart'?2:1,'literal startup state per start');
  if(arm==='invalid-mode')assert.ok(log.includes('[tss-ssr-concurrency] ignored TSS_SSR_COLD_OVERLAP=after_make'));
  if(arm==='invalid-switch')assert.ok(log.includes('[tss-ssr-concurrency] ignored TSS_SSR_CONCURRENT=true'));
 }
 console.log(scenario,index,arm,run.status,(run.stdout+run.stderr).slice(-2500));
 return {result,status:run.status};
};

const arms=['gate-only','barrier','after-make','after-seal','after-emit'];
const checked=(arm,scenario,index)=>{const r=execute(arm,scenario,index);assert.equal(r.status,0,arm+' '+scenario+' failed, see '+r.result);return {...r,arm};};
const read=(r,f)=>JSON.parse(fs.readFileSync(path.join(r.result,f)));
fs.writeFileSync(path.join(work,'request-gate.json'),JSON.stringify(await requestGate(v3['plugin.js']),null,2));
const selected=process.env.V4_STAGE||'cold';
if(selected==='production'){
 const results=['stock',...arms].map(arm=>checked(arm,'production',process.env.V4_INDEX||0));
 for(const r of results.slice(1))for(const file of ['production-dependencies.json','production-taps.json','production-assets.json'])assert.deepEqual(read(r,file),read(results[0],file),r.arm+' '+file+' pristine production parity');
 fs.writeFileSync(path.join(work,'production-parity.json'),JSON.stringify({passed:true,arms:['stock',...arms]}));
}else if(selected==='cold'){
 const results=arms.map(arm=>checked(arm,'cold',process.env.V4_INDEX||0));
 const reference=read(results[0],'initial-outputs.json');
 for(const r of results){
  const output=read(r,'initial-outputs.json');
  const generated=read(r,'route-tree-noop.json');assert.equal(generated.before,generated.after,r.arm+' startup generator byte identity');
  assert.equal(read(r,'builds.json').filter(b=>b.step==='initial'&&b.name==='client').length,1,r.arm+' exactly one client cold pass');
  for(const name of ['client','ssr','aux-a','aux-b'])assert.deepEqual(output[name],reference[name],r.arm+' '+name+' exact cold output bytes and modules');
  assert.equal(read(r,'builds.json').filter(b=>b.step==='initial'&&b.name==='ssr').length,1,r.arm+' exactly one SSR cold pass');
 }
 fs.writeFileSync(path.join(work,'cold-parity.json'),JSON.stringify({passed:true,arms}));
}else if(selected==='measure'){
 const orders=[arms,[...arms].reverse(),arms];
 fs.writeFileSync(path.join(work,'measurement-orders.json'),JSON.stringify(orders));
 for(let i=0;i<3;i++)for(const arm of orders[i])checked(arm,'cold-measure',i);
}else if(selected==='gate'){
 for(const arm of arms)checked(arm,'v4-cold-request',process.env.V4_INDEX||0);
}else if(selected==='failure'){
 for(const arm of (process.env.V4_ARM?[process.env.V4_ARM]:['after-seal','after-emit']))for(const scenario of (process.env.V4_SCENARIO?[process.env.V4_SCENARIO]:['v4-compile-error','v4-client-error']))checked(arm,scenario,process.env.V4_INDEX||0);
}
