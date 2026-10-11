import fs from 'node:fs';
import { structural, execution } from './check-rsc.mjs';
import crypto from 'node:crypto';
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
const structuralApply=spawnSync('patch',['--batch','--fuzz=0','-p1','-i',path.join(fixture,'start-plugin-core-1.171.46-combined.patch')],{cwd:pkg,encoding:'utf8'});
fs.writeFileSync(path.join(work,'r2b-clean-apply.log'),structuralApply.stdout+structuralApply.stderr);
assert.equal(structuralApply.status,0);assert.ok(!/offset|fuzz|FAILED/i.test(structuralApply.stdout+structuralApply.stderr));
const candidate=Object.fromEntries(['plugin.js','virtual-modules.js'].map(f=>[f,fs.readFileSync(path.join(dist,f),'utf8')]));
const structure=structural(originals,candidate);
fs.writeFileSync(path.join(work,'r2b-structural.json'),JSON.stringify(structure,null,2));
assert.ok(structure.passed,'RSC byte equality before syntax, execution, or watch validation');
fs.writeFileSync(path.join(work,'r2b-execution.json'),JSON.stringify(await execution(originals,candidate,pkg,work),null,2));
if(process.env.MODE==='r2b-red') process.exit(0);
const execute=(arm,scenario,index)=>{
 const result=path.join(work,`${scenario}-${index}-${arm}`); fs.mkdirSync(result,{recursive:true});
 for(const [f,text] of Object.entries(originals)) fs.writeFileSync(path.join(dist,f),text);
 if(arm!=='stock') {
  const patchFile=arm==='v2'?path.join(root,'benchmarks/tanstack-topology/start-plugin-core-1.171.46-gate-resolver-rebuild-v2.patch'):path.join(fixture,'start-plugin-core-1.171.46-combined.patch');
  const apply=spawnSync('patch',['--batch','--fuzz=0','-p1','-i',patchFile],{cwd:pkg,encoding:'utf8'});
  fs.writeFileSync(path.join(result,'patch-apply.log'),apply.stdout+apply.stderr); assert.equal(apply.status,0,'pristine dist patch applies');assert.ok(!/offset|fuzz|FAILED/i.test(apply.stdout+apply.stderr),'clean apply without offsets or fuzz');
 }
 const expected=arm==='stock'?{ 'plugin.js':'c892ae8404c1e30a2f409fcf1890713453fd465b9a515a5d5a8e685160d1e63b','virtual-modules.js':'8b1aca7c277767ae7a84cb63057b34d4e2dc1b7b90e150a2bb9cf47a4c3bc8a6' }:{ 'plugin.js':'7facb464609413c2878889abc0dd413cc8a1fe1655a8a620b768ac8d0852146f','virtual-modules.js':'186d9992310fd77ebd06b91419c2de95029e67919d2ab29e1ff069da0e3984d0' };
 for(const file of ['plugin.js','virtual-modules.js']) {
  if(arm!=='v2')assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,file))).digest('hex'),expected[file],`${file}: pristine/patched output byte-for-byte hash`);
  const checked=spawnSync('node',['--check',path.join(dist,file)],{encoding:'utf8'});
  fs.writeFileSync(path.join(result,`${file}-syntax.log`),checked.stdout+checked.stderr);assert.equal(checked.status,0,`${file}: syntax`);
  fs.copyFileSync(path.join(dist,file),path.join(result,`unobserved-${file}`));
 }
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
 const run=spawnSync('/usr/bin/time',['-v','-o',path.join(result,'process-time.txt'),'python3',path.join(fixture,'measure-process.py')],{cwd:app,env:{...process.env,NODE_ENV:'development',RESULT_DIR:result,ARM:arm,SCENARIO:scenario,TSS_SSR_CONCURRENT:arm==='gate-only'?'0':arm==='invalid-switch'?'true':'1',TSS_SSR_COLD_OVERLAP:arm==='overlap'?'1':arm==='after-make'?'after-make':arm==='invalid-mode'?'after_make':'0'},encoding:'utf8',timeout:900000});
 fs.writeFileSync(path.join(result,'console.log'),run.stdout+run.stderr);
 fs.writeFileSync(path.join(result,'exit.json'),JSON.stringify({status:run.status,signal:run.signal,error:run.error?.message}));
 if(run.status===0 && arm!=='stock' && arm!=='v2') {
  const log=fs.readFileSync(path.join(result,'node-console.log'),'utf8');
  const state=scenario==='r2-topology'?'disengaged reason=topology (names-or-dependencies)':arm==='gate-only'?'disengaged reason=switch (TSS_SSR_CONCURRENT=0)':`engaged mode=${arm==='after-make'?'after-make':arm==='overlap'?'1':'default'}`;
  assert.equal(log.split(`[tss-ssr-concurrency] ${state} gate=on`).length-1,scenario==='r2-restart'?2:1,'literal startup state per start');
  if(arm==='invalid-mode')assert.ok(log.includes('[tss-ssr-concurrency] ignored TSS_SSR_COLD_OVERLAP=after_make'));
  if(arm==='invalid-switch')assert.ok(log.includes('[tss-ssr-concurrency] ignored TSS_SSR_CONCURRENT=true'));
 }
 console.log(scenario,index,arm,run.status,(run.stdout+run.stderr).slice(-2500));
 return {result,status:run.status};
};
const mode=process.env.MODE || 'red';
let failed=false;
if(mode==='r2-measure') {
 const orders=[];
 for(let i=1;i<=10;i++) {
  for(const scenario of ['cold-measure','warm-leaf','warm-body']) {
   const forward=scenario==='cold-measure'?['stock','gate-only','barrier','after-make']:['stock','gate-only','barrier'];
   const arms=i%2?forward:[...forward].reverse();orders.push({index:i,scenario,arms});
   for(const arm of arms) {const r=execute(arm,scenario,i);assert.equal(r.status,0,'failed command is not a measurement sample');}
  }
 }
 fs.writeFileSync(path.join(work,'arm-orders.json'),JSON.stringify(orders,null,2));
 process.exit(0);
}

if(mode==='r2-final') {
 for(const [arm,scenario] of [['barrier','r2-close'],['after-make','r2-close'],['barrier','r2-restart'],['after-make','r2-child'],['barrier','r2-done'],['barrier','r2-passes'],['barrier','r2-topology']]) {const r=execute(arm,scenario,0);assert.equal(r.status,0,'focused final case');}
 for(const arm of ['barrier','gate-only','after-make','overlap'])for(const scenario of ['r2-read','red-aba','red-recovery','no-resolver']) {const r=execute(arm,scenario,0);assert.equal(r.status,0,'final resolver convergence');}
 for(const arm of ['invalid-mode','invalid-switch']){const r=execute(arm,'cold',0);assert.equal(r.status,0,'final exact env logging');}
} else if(mode==='r2-extra') {
 for(const arm of ['barrier','gate-only','after-make','overlap']) {const r=execute(arm,'r2-read',0);if(r.status!==0)failed=true;}
 const r=execute('barrier','r2-topology',0);if(r.status!==0)failed=true;
} else if(mode==='r2-matrix') {
 for(const arm of ['barrier','after-make','gate-only','overlap']) {
  for(const scenario of ['red-recovery','red-aba','no-resolver']) {const r=execute(arm,scenario,0);if(r.status!==0)failed=true;}
 }
 for(const arm of ['invalid-mode','invalid-switch']) {const r=execute(arm,'cold',0);if(r.status!==0)failed=true;}
} else if(mode==='r2-green') {
 for(const [arm,scenario] of [['barrier','r2-close'],['after-make','r2-close'],['barrier','r2-restart'],['after-make','r2-child'],['barrier','r2-done'],['barrier','r2-passes'],['barrier','red-recovery'],['barrier','red-aba'],['barrier','no-resolver']]) {const r=execute(arm,scenario,0);if(r.status!==0)failed=true;}
} else if(mode==='r2-red') {
 for(const [arm,scenario] of [['barrier','r2-close'],['after-make','r2-close'],['barrier','r2-restart'],['after-make','r2-child'],['barrier','r2-done'],['barrier','r2-passes']]) {const r=execute(arm,scenario,0);if(r.status!==0)failed=true;}
} else if(mode==='final') {
 for(const [arm,scenario] of [['barrier','no-resolver'],['barrier','red-overlap'],['barrier','red-recovery'],['barrier','red-aba'],['after-make','red-after-make']]) {const r=execute(arm,scenario,0);if(r.status!==0)failed=true;}
}
if(mode==='r2-extra'||mode==='r2-red'||mode==='r2-green') {} else if(mode==='supplement') {for(const arm of ['overlap','after-make','barrier','stock']){const r=execute(arm,'warm',10);if(r.status!==0)failed=true;}
} else if(mode==='no-resolver') {const r=execute('barrier','no-resolver',0);failed=r.status!==0;
} else if(mode==='red-aba') {const r=execute('barrier','red-aba',0);failed=r.status!==0;
} else if(mode==='aa-route') {for(let i=0;i<2;i++){const r=execute('stock','aa-route',i);if(r.status!==0)failed=true;}
} else if(mode==='red-after-make') { const r=execute('after-make','red-after-make',0);failed=r.status!==0;
} else if(mode==='regression') {
 for(const [arm,scenario] of [['barrier','red-overlap'],['barrier','red-recovery'],['barrier','red-aba'],['after-make','red-after-make']]) {const r=execute(arm,scenario,0); if(r.status!==0) failed=true;}
} else if(mode==='red') {
 for(const [arm,scenario] of [['stock','red-overlap'],['v2','red-recovery']]) { const r=execute(arm,scenario,0); if(r.status!==0) failed=true; }
} else {
 const reps=mode==='measure'||mode==='final'?10:1;
 for(let i=0;i<reps;i++) {
  const arms=(mode==='r2-matrix'||mode==='r2-final')?['stock','gate-only','barrier','after-make','overlap']:i%2?['overlap','after-make','barrier','stock']:['stock','barrier','after-make','overlap'];
  const results=arms.map(arm=>({...execute(arm,mode==='measure'||mode==='final'&&i>0?'warm':'correctness',i),arm}));
  if(results.some(r=>r.status!==0)) {failed=true;break;}
  if(mode!=='measure' && (mode!=='final'||i===0)) {
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
