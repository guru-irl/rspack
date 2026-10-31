// Cycle-2 adversarial driver for PR #59 (b87c553c). Harness adapted from cycle 1's adv5.cjs.
// usage: node adv-c2.cjs <repo> <label> <native|watchpack> <binding sha256> [sessions,comma,separated]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const [repo, label, mode, wantedHash, onlyArg] = process.argv.slice(2);
assert(repo && label && ['native', 'watchpack'].includes(mode) && wantedHash);
assert(process.env.NAPI_RS_NATIVE_LIBRARY_PATH, 'binding pin missing');
const only = onlyArg ? new Set(onlyArg.split(',')) : null;
const { rspack } = require(repo + '/packages/rspack/dist/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(process.env.ADV_BASE + '/' + label + '-');
const results = [];
let bindingChecked = false;
function identity() {
 if (bindingChecked) return;
 const mapped = [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n').map(l => l.trim().split(/\s+/).slice(5).join(' ')).filter(p => p.endsWith('.node') && p.includes('rspack')))];
 assert.equal(mapped.length, 1, JSON.stringify(mapped));
 assert.equal(mapped[0], fs.realpathSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH), 'mapped binding is not the pinned one');
 const sha = crypto.createHash('sha256').update(fs.readFileSync(mapped[0])).digest('hex');
 assert.equal(sha, wantedHash, 'wrong mapped binding');
 console.log(JSON.stringify({type:'identity', label, mode, binding:mapped[0], sha}));
 bindingChecked = true;
}
function write(p, contents, initial = false) {
 fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, contents);
 if (initial) { const past = new Date(Date.now() - 15000); fs.utimesSync(p, past, past); }
}
function rawWatches() { let raw = 0; for (const fd of fs.readdirSync('/proc/self/fdinfo')) { let info; try { info = fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8'); } catch { continue; } for (const line of info.split('\n')) if (line.startsWith('inotify wd:')) raw++; } return raw; }
function counts(source) {
 const watches = new Set(); let raw=0;
 for (const fd of fs.readdirSync('/proc/self/fdinfo')) {
  let info; try { info = fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8'); } catch { continue; }
  for (const line of info.split('\n')) if (line.startsWith('inotify wd:')) { raw++; watches.add(BigInt('0x' + line.match(/ino:([0-9a-f]+)/)[1]).toString()); }
 }
 const seen=new Set(); let visible=0, unwatched=[];
 function walk(dir, rel) { let st; try { st=fs.statSync(dir,{bigint:true}); } catch { return; } if(!st.isDirectory()||seen.has(st.ino.toString())) return; seen.add(st.ino.toString());
  if(watches.has(st.ino.toString())) visible++; else if (unwatched.length < 12) unwatched.push(rel);
  let names=[]; try { names=fs.readdirSync(dir); } catch {} for(const name of names) walk(path.join(dir,name), rel ? rel + '/' + name : name);
 }
 walk(source, ''); return {visible, total:watches.size, raw, unwatched};
}
function rel(source, set) {
 if (!set) return null;
 const real = fs.realpathSync(source);
 return [...set].map(p => p.startsWith(source + '/') ? p.slice(source.length + 1) : p === source ? '.' : p.startsWith(real + '/') ? 'REAL:' + p.slice(real.length + 1) : p === real ? 'REAL:.' : p).sort();
}
async function session(name, setup, run, opts = {}) {
 if (only && !only.has(name)) return;
 fs.writeSync(2, `SESSION ${name} INIT\n`);
 const followSymlinks = opts.followSymlinks ?? true;
 const source=path.join(root,name,'src'), out=path.join(root,name,'out');
 fs.mkdirSync(source, {recursive:true}); const state=setup(source);
 const compiler=rspack({context:source, mode:'development', target:'node', devtool:false,
  entry:'./index.js', resolve:{symlinks:false},
  output:{path:out,filename:'bundle.js',library:{type:'commonjs2'}},
  experiments:{nativeWatcher:mode==='native'},
  plugins:[compiler=>compiler.hooks.thisCompilation.tap('adv', compilation=> {
   for(const p of state.contexts || []) compilation.contextDependencies.add(path.join(source,p));
   for(const p of state.files || []) compilation.fileDependencies.add(path.join(source,p));
   for(const p of state.missing || []) compilation.missingDependencies.add(path.join(source,p));
  })]
 });
 let builds=0, errors=[], watching, pending, mods=[], stderrMark=0;
 const output = () => { try { const module={exports:{}}; vm.runInNewContext(fs.readFileSync(path.join(out,'bundle.js'),'utf8'),{module, exports:module.exports}); return JSON.parse(JSON.stringify(module.exports)); } catch(e) { return 'ERR:'+e.message; } };
 function next(ms=4000) { assert(!pending); return new Promise(resolve=> {
  const timer=setTimeout(()=>{pending=undefined;resolve(false);},ms);
  pending=()=>{clearTimeout(timer);pending=undefined;resolve(true);};
 }); }
 const first=next(60000);
 const t0w=Date.now();
 watching=compiler.watch({aggregateTimeout:50,followSymlinks,ignored:/(?:^|\/)ignored(?:\/|$)/},(err,stats)=>{
  builds++; if(err || stats?.hasErrors()) errors.push(String(err||stats.toString()).slice(0,400));
  mods.push({mod: rel(source, compiler.modifiedFiles), rem: rel(source, compiler.removedFiles)});
  pending?.();
 });
 let loops=0; async function settled() { let n; const t=Date.now(); do {n=builds; await sleep(250);} while(n!==builds && Date.now()-t<15000); if(n!==builds) { loops++; console.log(JSON.stringify({type:"unsettled",scenario:name,builds})); } }
 // kind: 'rebuild' (default) expects a build; 'quiet' expects none; 'observe' records only.
 async function step(id, change, expected, kind='rebuild', wait=4000) {
  try { fs.writeSync(2, "STEP " + name + " " + id + "\n"); } catch {}
  await settled(); fs.writeSync(2, `BEFORE ${name} ${id} raw=${rawWatches()}\n`); const before=builds, errBefore=errors.length, modBefore=mods.length; const done=kind==='rebuild'?next(wait):null; const t0=Date.now(); await change();
  let noticed;
  if(kind==='rebuild') noticed=await done; else { await sleep(Math.max(1200, wait === 4000 ? 1200 : wait)); noticed=builds>before; }
  await settled(); const actual=output(); let outputOk=true;
  if(expected!==undefined) {try {assert.deepEqual(actual,expected);} catch {outputOk=false;} }
  const c=opts.noCounts ? null : counts(source);
  const ok = kind==='observe' ? outputOk : (kind==='quiet' ? (!noticed && outputOk) : (noticed && outputOk && errors.length===errBefore));
  const row={type:'row',label,mode,scenario:name,followSymlinks,id,kind,ok,noticed,builds:builds-before,outputOk,actual:typeof actual==='object'&&Object.keys(actual||{}).length>30?'(large)':actual,expected:typeof expected==='object'&&Object.keys(expected||{}).length>30?'(large)':expected,newErrors:errors.slice(errBefore),changes:mods.slice(modBefore),counts:c,ms:Date.now()-t0};
  results.push(row); console.log(JSON.stringify(row));
  if((kind==='rebuild' && !noticed) || !outputOk) { const recovery=next(); try { watching.invalidate(); } catch(e) { row.recovery='invalidate threw '+e.message; } const r=await recovery; if(!r) console.log(JSON.stringify({type:'recovery-timeout',id})); await settled(); }
 }
 try { assert(await first,'initial build timed out'); identity();
  if (opts.duringStart) await opts.duringStart({source,state,t0w});
  await settled();
  const r0={type:'row',label,mode,scenario:name,followSymlinks,id:'INIT',kind:'observe',ok:true,actual:'(see)',errors:errors.slice(),counts:opts.noCounts?null:counts(source),ms:Date.now()-t0w}; console.log(JSON.stringify(r0));
  await run({source,state,step,output,watching,settled,errors,builds:()=>builds});
 }
 finally {await new Promise(res=>watching.close(()=>res())); await new Promise(res=>compiler.close(()=>res()));}
}
const entry='const c = require.context("./ctx", true, /\\.js$/); module.exports = Object.fromEntries(c.keys().sort().map(k => [k, c(k)]));\n';
const W=(s)=>(p,v)=>write(path.join(s,p),'module.exports = '+v+';\n');
const T=(s)=>(p,v)=>write(path.join(s,p),v);
const one='module.exports = 1;\n';

// c4: a recursive upgrade that fails part way, on a folder whose subfolders hold their own patterns.
async function limitpart() {
 const D=+(process.env.LIMIT_DIRS||40);
 await session('limitpart',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'p/a.txt'),'a',true); write(path.join(s,'p/q/b.txt'),'b',true);
  write(path.join(s,'p/r/c.txt'),'c',true);
  for (let i=0;i<D;i++) fs.mkdirSync(path.join(s,'p/many/i'+i),{recursive:true});
  return {files:['p/a.txt','p/q/b.txt'],contexts:['p/r']};
 },async({source:s,state,step,watching})=>{
  const t=T(s);
  await step('V01',()=>t('p/q/b.txt','b1'),1,'rebuild',12000);
  await step('V02',()=>{state.missing=['p/m1/m2/x.txt']; watching.invalidate();},1,'rebuild',12000);
  await step('V03',()=>t('p/q/b.txt','b2'),1,'rebuild',12000);
  await step('V04',()=>t('p/a.txt','a1'),1,'rebuild',12000);
  await step('V05',()=>t('p/r/c.txt','c1'),1,'rebuild',12000);
  await step('V06',()=>t('p/r/new.txt','n'),1,'rebuild',12000);
  await step('V07',()=>{state.missing=[]; watching.invalidate();},1,'rebuild',12000);
  await step('V08',()=>t('p/q/b.txt','b3'),1,'rebuild',12000);
  await step('V09',()=>t('p/r/c.txt','c2'),1,'rebuild',12000);
 });
}
// c4: delete and recreate a context root after the first eviction, then add a new context.
async function limitctxroot() {
 const D=+(process.env.LIMIT_DIRS||40);
 await session('limitctxroot',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'other/f.txt'),'f',true); write(path.join(s,'ctx/top.txt'),'t',true);
  for (let i=0;i<D;i++) write(path.join(s,'ctx/d'+i+'/x.txt'),'x',true);
  return {contexts:['ctx'],files:['other/f.txt']};
 },async({source:s,state,step,watching})=>{
  const t=T(s);
  await step('K01',()=>{t('other2/g.txt','g'); state.files=['other/f.txt','other2/g.txt']; watching.invalidate();},1,'rebuild',12000);
  await step('K02',()=>t('other2/g.txt','g1'),1,'rebuild',12000);
  await step('K03',()=>t('ctx/top.txt','t1'),1,'rebuild',12000);
  await step('K04',()=>fs.rmSync(path.join(s,'ctx'),{recursive:true}),1,'rebuild',12000);
  await step('K05',()=>t('ctx/top.txt','t2'),1,'rebuild',12000);
  await step('K06',()=>t('ctx/top.txt','t3'),1,'rebuild',12000);
  await step('K07',()=>t('ctx/top2.txt','u'),1,'rebuild',12000);
  await step('K08',()=>t('other2/g.txt','g2'),1,'rebuild',12000);
  await step('K09',()=>{t('ctx3/a.txt','a'); state.contexts=['ctx','ctx3']; watching.invalidate();},1,'rebuild',12000);
  await step('K10',()=>t('ctx3/a.txt','a1'),1,'rebuild',12000);
  await step('K11',()=>t('ctx3/b.txt','b'),1,'rebuild',12000);
  await step('K12',()=>t('other/f.txt','f1'),1,'rebuild',12000);
 });
}
// c4: compilers in one process share the OS watch quota. Compiler c0 has only file dependencies;
// the others register large contexts.
async function limitmc(kind) {
 const name='limitmc-'+kind; if (only && !only.has(name)) return;
 fs.writeSync(2, `SESSION ${name} INIT\n`);
 const D=+(process.env.LIMIT_DIRS||40), N=+(process.env.MC_N||(kind==='starve'?2:4));
 const source=path.join(root,name,'src'); fs.mkdirSync(source,{recursive:true});
 const names=[...Array(N).keys()].map(i=>'c'+i);
 const state={};
 for (const n of names) {
  write(path.join(source,n,'index.js'),one,true); write(path.join(source,n,'other/f.txt'),'f',true);
  const ctx = kind==='starve' ? n!=='c0' : true;
  if (ctx) for (let i=0;i<D;i++) write(path.join(source,n,'ctx/d'+i+'/x.txt'),'x',true);
  state[n]={contexts:ctx?[n+'/ctx']:[],files:[n+'/other/f.txt']};
 }
 const cfg=n=>({name:n,context:path.join(source,n),mode:'development',target:'node',devtool:false,entry:'./index.js',resolve:{symlinks:false},
  output:{path:path.join(root,name,'out-'+n),filename:'bundle.js',library:{type:'commonjs2'}},experiments:{nativeWatcher:mode==='native'},
  plugins:[c=>c.hooks.done.tap("advDone",()=>{per[n]++;}),c=>c.hooks.thisCompilation.tap('adv',comp=>{for(const p of state[n].contexts) comp.contextDependencies.add(path.join(source,p)); for(const p of state[n].files) comp.fileDependencies.add(path.join(source,p));})]});
 let builds=0, pending; const per=Object.fromEntries(names.map(n=>[n,0])); const errors=[];
 const compiler=rspack(names.map(cfg));
 const next=(ms=4000)=>new Promise(res=>{const tm=setTimeout(()=>{pending=undefined;res(false);},ms); pending=()=>{clearTimeout(tm);pending=undefined;res(true);};});
 const first=next(60000);
 const watching=compiler.watch({aggregateTimeout:50,followSymlinks:true},(err,stats)=>{builds++; if(err||stats?.hasErrors()) errors.push(String(err||stats.toString()).slice(0,300)); pending?.();});
 async function settled(){let n;const t=Date.now();do{n=builds;await sleep(400);}while(n!==builds&&Date.now()-t<15000);}
 const t=T(source);
 async function step(id,who,change){await settled();const pb={...per};const b0=builds;const e0=errors.length;const raw0=rawWatches();await change();
  const t0=Date.now(); while(per[who]===pb[who]&&Date.now()-t0<12000) await sleep(100); await settled();
  const noticed=per[who]>pb[who];
  const row={type:'row',label,mode,scenario:name,id,kind:'rebuild',who,ok:noticed&&errors.length===e0,noticed,builds:builds-b0,perCompiler:Object.fromEntries(names.map(n=>[n,per[n]-pb[n]])),newErrors:errors.slice(e0),rawBefore:raw0,rawAfter:rawWatches(),ms:Date.now()-t0}; results.push(row); console.log(JSON.stringify(row));
  if(!noticed){const r=next(12000);watching.invalidate();await r;await settled();}}
 try{ assert(await first,'initial build timed out'); identity(); await settled(); await sleep(1500); await settled();
  console.log(JSON.stringify({type:'row',label,mode,scenario:name,id:'INIT',kind:'observe',ok:true,raw:rawWatches(),errors:errors.slice()}));
  for (const n of names) await step('M01-'+n,n,()=>t(n+'/other/f.txt','f1'));
  await step('M02-c0','c0',()=>{t('c0/other2/g.txt','g'); state.c0.files.push('c0/other2/g.txt'); watching.invalidate();});
  await step('M03-c0','c0',()=>t('c0/other2/g.txt','g1'));
  const last=names[N-1];
  await step('M04-'+last,last,()=>{t(last+'/other2/g.txt','g'); state[last].files.push(last+'/other2/g.txt'); watching.invalidate();});
  await step('M05-'+last,last,()=>t(last+'/other2/g.txt','g1'));
  await step('M06-c0','c0',()=>t('c0/other2/g.txt','g2'));
  for (const n of names) await step('M07-'+n,n,()=>t(n+'/other/f.txt','f2'));
 } finally { await new Promise(r=>watching.close(()=>r())); }
}
const all = { limitpart, limitctxroot, 'limitmc-starve':()=>limitmc('starve'), 'limitmc-even':()=>limitmc('even') };
(async()=>{
 for (const [n,f] of Object.entries(all)) { if (only && !only.has(n)) continue; await f(); }
 console.log(JSON.stringify({type:'summary',label,mode,rows:results.length,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).map(r=>r.scenario+':'+r.id),root}));
})().catch(err=>{console.error(err);process.exitCode=1;});
