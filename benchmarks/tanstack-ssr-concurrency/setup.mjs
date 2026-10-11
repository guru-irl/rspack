import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const root=process.cwd();
const fixture=path.join(root,'benchmarks/tanstack-ssr-concurrency');
const work=process.env.WORK_DIR || path.join(root,'bench-results/tanstack-ssr-concurrency');
const app=path.join(work,'app');
fs.mkdirSync(app,{recursive:true});
const deps={ '@rsbuild/core':'2.2.12','@rsbuild/plugin-react':'2.1.1','@tanstack/react-start':'1.168.61','@tanstack/react-router':'1.170.42','@tanstack/start-plugin-core':'1.171.46','@tanstack/start-server-core':'1.169.40','react':'19.3.0','react-dom':'19.3.0','@rspack/core':'2.2.8' };
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'public-watch-fixture',private:true,type:'module',dependencies:deps,overrides:{'@rspack/core':'2.2.8','@tanstack/start-plugin-core':'1.171.46','@tanstack/start-server-core':'1.169.40'}},null,2));
const install=spawnSync('npm',['install','--registry=https://registry.npmjs.org','--no-audit','--no-fund'],{cwd:app,encoding:'utf8',timeout:600000});
fs.writeFileSync(path.join(work,'install.log'),install.stdout+install.stderr); assert.equal(install.status,0,'public npm install');
const pkg=path.join(app,'node_modules/@tanstack/start-plugin-core');
const dist=path.join(pkg,'dist/esm/rsbuild');
const originals=Object.fromEntries(['plugin.js','start-compiler-host.js','virtual-modules.js'].map(f=>[f,fs.readFileSync(path.join(dist,f),'utf8')]));
fs.copyFileSync(path.join(app,'package-lock.json'),path.join(work,'package-lock.json'));
const execute=(arm,scenario,index)=>{
 const result=path.join(work,`${scenario}-${index}-${arm}`); fs.mkdirSync(result,{recursive:true});
 for(const [f,text] of Object.entries(originals)) fs.writeFileSync(path.join(dist,f),text);
 if(arm!=='stock') {
  const patchFile=arm==='v2'?path.join(root,'benchmarks/tanstack-topology/start-plugin-core-1.171.46-gate-resolver-rebuild-v2.patch'):path.join(fixture,'start-plugin-core-1.171.46-combined.patch');
  const apply=spawnSync('patch',['--batch','--fuzz=0','-p1','-i',patchFile],{cwd:pkg,encoding:'utf8'});
  fs.writeFileSync(path.join(result,'patch-apply.log'),apply.stdout+apply.stderr); assert.equal(apply.status,0,'pristine dist patch applies');
 }
 fs.copyFileSync(path.join(dist,'plugin.js'),path.join(result,'unobserved-plugin.js'));
 // Observation only: preserve the real virtual module object and all decisions.
 let plugin=fs.readFileSync(path.join(dist,'plugin.js'),'utf8');
 plugin=plugin.replace('updateServerFnResolver = virtualModuleState.updateServerFnResolver;','updateServerFnResolver = virtualModuleState.updateServerFnResolver;\n globalThis.__watchVirtualState = virtualModuleState;');
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
 fs.copyFileSync(path.join(fixture,'run.mjs'),path.join(app,'run.mjs'));
 const run=spawnSync('/usr/bin/time',['-v','-o',path.join(result,'process-time.txt'),'python3',path.join(fixture,'measure-process.py')],{cwd:app,env:{...process.env,NODE_ENV:'development',RESULT_DIR:result,ARM:arm,SCENARIO:scenario,TSS_SSR_COLD_OVERLAP:arm==='overlap'?'1':arm==='after-make'?'after-make':'0'},encoding:'utf8',timeout:900000});
 fs.writeFileSync(path.join(result,'console.log'),run.stdout+run.stderr);
 fs.writeFileSync(path.join(result,'exit.json'),JSON.stringify({status:run.status,signal:run.signal,error:run.error?.message}));
 console.log(scenario,index,arm,run.status,(run.stdout+run.stderr).slice(-2500));
 return {result,status:run.status};
};
const mode=process.env.MODE || 'red';
let failed=false;
if(mode==='no-resolver') {const r=execute('barrier','no-resolver',0);failed=r.status!==0;
} else if(mode==='red-aba') {const r=execute('barrier','red-aba',0);failed=r.status!==0;
} else if(mode==='aa-route') {for(let i=0;i<2;i++){const r=execute('stock','aa-route',i);if(r.status!==0)failed=true;}
} else if(mode==='red-after-make') { const r=execute('after-make','red-after-make',0);failed=r.status!==0;
} else if(mode==='regression') {
 for(const [arm,scenario] of [['barrier','red-overlap'],['barrier','red-recovery'],['barrier','red-aba'],['after-make','red-after-make']]) {const r=execute(arm,scenario,0); if(r.status!==0) failed=true;}
} else if(mode==='red') {
 for(const [arm,scenario] of [['stock','red-overlap'],['v2','red-recovery']]) { const r=execute(arm,scenario,0); if(r.status!==0) failed=true; }
} else {
 const reps=mode==='measure'?10:1;
 for(let i=0;i<reps;i++) {
  const arms=i%2?['overlap','after-make','barrier','stock']:['stock','barrier','after-make','overlap'];
  const results=arms.map(arm=>({...execute(arm,mode==='measure'?'warm':'correctness',i),arm}));
  if(results.some(r=>r.status!==0)) {failed=true;break;}
  if(mode!=='measure') {
   const visible=r=>JSON.parse(fs.readFileSync(path.join(r.result,'checks.json'))).map(({step,responses,calls,removedCalls})=>({step,responses,calls,removedCalls}));
   const stock=results.find(r=>r.arm==='stock');
   for(const r of results.filter(r=>r.arm!=='stock')) {
    assert.deepEqual(visible(r),visible(stock),`${r.arm}: SSR HTML and RPC parity`);
    for(const check of visible(stock)) {
     const output=r=>JSON.parse(fs.readFileSync(path.join(r.result,`${check.step}-outputs.json`)));
     const a=output(stock), b=output(r);
     for(const env of ['client','ssr']) {assert.deepEqual(b[env].modules,a[env].modules,`${r.arm} ${check.step}: ${env} final module-output parity`);const stable=assets=>assets.map(({hash,...rest})=>rest);assert.deepEqual(stable(b[env].assets),stable(a[env].assets),`${r.arm} ${check.step}: ${env} emitted asset parity after full-hash normalization`);}
    }
   }
   fs.writeFileSync(path.join(work,'parity.json'),JSON.stringify({passed:true,steps:visible(stock).length}));
  }
 }
}
if(failed) process.exitCode=1;
