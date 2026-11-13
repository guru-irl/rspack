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

// F3: deleting a symlink that notify's recursive walk followed, inside a recursive root.
async function zunlink(follow) {
 await session('zunlink-'+follow,s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'zr/real/f.txt'),'f',true);
  fs.symlinkSync('real',path.join(s,'zr/link'));
  return {files:['zr/real/f.txt'],contexts:['zr/real'],missing:['zr/m1/m2/m.txt']};
 },async({source:s,step})=>{
  const t=T(s);
  await step('U01',()=>t('zr/real/f.txt','f1'),1);
  await step('U02',()=>fs.unlinkSync(path.join(s,'zr/link')),1,'observe');
  await step('U03',()=>t('zr/real/f.txt','f2'),1);
  await step('U04',()=>t('zr/real/new.txt','n'),1);
  await step('U05',()=>t('zr/real/f.txt','f3'),1);
 },{followSymlinks:follow});
}
// F3 variant: unregistered links in a recursive root label the real directory's descriptor.
async function zlink(follow) {
 await session('zlink-'+follow,s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'zr/real/f.txt'),'f',true);
  for (const n of ['l1','l2','l3','l4','l5','l6','z9']) fs.symlinkSync('real',path.join(s,'zr',n));
  return {files:['zr/real/f.txt'],contexts:['zr/real'],missing:['zr/m1/m2/m.txt']};
 },async({source:s,step})=>{
  const t=T(s);
  await step('K01',()=>t('zr/real/f.txt','f1'),1);
  await step('K02',()=>t('zr/real/new.txt','n'),1);
  await step('K03',()=>t('zr/real/f.txt','f2'),1);
 },{followSymlinks:follow});
}
// Focus 2: two spellings of one directory through recursive upgrades/downgrades, deletion and alias removal.
async function twin(follow) {
 await session('twin-'+follow,s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'ctx/a/sub/f.txt'),'f',true); write(path.join(s,'ctx/top.txt'),'t',true);
  fs.symlinkSync('a',path.join(s,'ctx/l'));
  return {contexts:['ctx'],missing:['ctx/m1/m2/m.txt']};
 },async({source:s,step})=>{
  const t=T(s);
  await step('B01',()=>t('ctx/a/sub/f.txt','f1'),1);
  await step('B02',()=>t('ctx/m1/m2/m.txt','m'),1);
  await step('B03',()=>t('ctx/a/sub/n1.txt','n'),1);
  await step('B04',()=>fs.rmSync(path.join(s,'ctx/m1'),{recursive:true}),1);
  await step('B05',()=>t('ctx/a/sub/n2.txt','n'),1);
  await step('B06',()=>{t('ctx/m1/m2/m.txt','m'); fs.rmSync(path.join(s,'ctx/a/sub'),{recursive:true});},1);
  await step('B07',()=>t('ctx/a/sub/n3.txt','n'),1);
  await step('B08',()=>t('ctx/a/sub/n4.txt','n'),1);
  await step('B09',()=>fs.rmSync(path.join(s,'ctx/m1'),{recursive:true}),1);
  await step('B10',()=>fs.unlinkSync(path.join(s,'ctx/l')),1);
  await step('B11',()=>t('ctx/a/sub/n5.txt','n'),1);
  await step('B12',()=>fs.symlinkSync('a',path.join(s,'ctx/l')),1);
  await step('B13',()=>t('ctx/a/sub/n6.txt','n'),1);
  await step('B14',()=>t('ctx/top.txt','t2'),1);
 },{followSymlinks:follow});
}
// Focus 1: alias whose canonical target is outside the context root, across recursive changes and target deletion.
async function outa() {
 await session('outa',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'out/t/a.txt'),'a',true); write(path.join(s,'out/t/sub/b.txt'),'b',true); write(path.join(s,'rc/x/seed.txt'),'s',true);
  fs.symlinkSync('../../out/t',path.join(s,'rc/x/link'));
  return {contexts:['rc'],missing:['rc/m1/m2/m.txt']};
 },async({source:s,step})=>{
  const t=T(s);
  await step('A01',()=>t('out/t/a.txt','a1'),1);
  await step('A02',()=>t('out/t/sub/new.txt','n'),1);
  await step('A03',()=>t('rc/m1/m2/m.txt','m'),1);
  await step('A04',()=>t('out/t/sub/new2.txt','n'),1);
  await step('A05',()=>fs.rmSync(path.join(s,'out/t'),{recursive:true}),1);
  await step('A06',()=>t('rc/x/new.txt','n'),1);
  await step('A07',()=>fs.rmSync(path.join(s,'rc/m1'),{recursive:true}),1);
  await step('A08',()=>t('out/t/sub/c.txt','c'),1,'observe');
  await step('A09',()=>t('rc/top.txt','t'),1);
  await step('A10',()=>t('out/t/sub/d.txt','d'),1,'observe');
  await step('A11',()=>t('rc/x/seed.txt','s2'),1);
 });
}
// Focus 1/2: lost permission on an outside alias target while recursive, then downgrade and recovery.
async function outperm() {
 await session('outperm',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'out/t/a.txt'),'a',true); write(path.join(s,'out/t/sub/b.txt'),'b',true); write(path.join(s,'rc/x/seed.txt'),'s',true);
  write(path.join(s,'rc/in/sub/c.txt'),'c',true);
  fs.symlinkSync('../../out/t',path.join(s,'rc/x/link')); fs.symlinkSync('../in',path.join(s,'rc/x/inlink'));
  return {contexts:['rc'],missing:['rc/m1/m2/m.txt']};
 },async({source:s,step})=>{
  const t=T(s);
  await step('O01',()=>t('out/t/sub/b.txt','b1'),1);
  await step('O02',()=>{fs.chmodSync(path.join(s,'out/t/sub'),0o000); fs.chmodSync(path.join(s,'rc/in/sub'),0o000);},1,'observe');
  await step('O03',()=>t('rc/m1/m2/m.txt','m'),1);
  await step('O04',()=>t('rc/x/n.txt','n'),1);
  await step('O05',()=>{fs.chmodSync(path.join(s,'out/t/sub'),0o755); fs.chmodSync(path.join(s,'rc/in/sub'),0o755);},1,'observe');
  await step('O06',()=>t('out/t/sub/e.txt','e'),1);
  await step('O07',()=>t('rc/in/sub/f.txt','f'),1);
  await step('O08',()=>t('out/t/a.txt','a2'),1);
 });
}
// New angle: a registered context root that is itself a symlink.
async function ctxroot(follow) {
 await session('ctxroot-'+follow,s=>{
  write(path.join(s,'index.js'),'const c = require.context("./lctx", true, /\\.js$/); module.exports = Object.fromEntries(c.keys().sort().map(k => [k, c(k)]));\n',true);
  write(path.join(s,'realctx/a/x.js'),one,true); fs.symlinkSync('realctx',path.join(s,'lctx'));
  return {};
 },async({source:s,step})=>{
  const w=W(s); const want={'./a/x.js':1};
  want['./a/y.js']=2; await step('C01',()=>w('realctx/a/y.js',2),{...want});
  want['./b/c/z.js']=3; await step('C02',()=>w('realctx/b/c/z.js',3),{...want});
  want['./a/v.js']=4; await step('C03',()=>w('lctx/a/v.js',4),{...want});
  delete want['./b/c/z.js']; await step('C04',()=>fs.rmSync(path.join(s,'realctx/b'),{recursive:true}),{...want});
  want['./a/x.js']=5; await step('C05',()=>w('realctx/a/x.js',5),{...want});
  want['./b/d/q.js']=6; await step('C06',()=>w('realctx/b/d/q.js',6),{...want});
 },{followSymlinks:follow});
}
// New angle: two registered contexts, one a symlink to the other; release either one.
async function ctxpair(follow) {
 await session('ctxpair-'+follow,s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'realctx/a/x.txt'),'x',true); fs.symlinkSync('realctx',path.join(s,'lctx'));
  return {contexts:['realctx','lctx']};
 },async({source:s,state,step,watching})=>{
  const t=T(s);
  await step('P01',()=>t('realctx/a/n1.txt','n'),1);
  await step('P02',()=>{state.contexts=['realctx']; watching.invalidate();},1);
  await step('P03',()=>t('realctx/a/n2.txt','n'),1);
  await step('P04',()=>{state.contexts=['lctx']; watching.invalidate();},1);
  await step('P05',()=>t('realctx/a/n3.txt','n'),1);
  await step('P06',()=>t('realctx/new/deep/n4.txt','n'),1);
  await step('P07',()=>t('realctx/new/deep/n5.txt','n'),1);
  await step('P08',()=>{state.contexts=[]; watching.invalidate();},1);
  await step('P09',()=>t('realctx/a/n6.txt','n'),1,'quiet');
 },{followSymlinks:follow});
}
// New angle: many contexts sharing directories, released one by one, with an alias context inside.
async function manyctx() {
 await session('manyctx',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'m/a/b/c/f.txt'),'f',true); write(path.join(s,'m/top.txt'),'t',true);
  fs.symlinkSync('a',path.join(s,'m/x'));
  return {contexts:['m','m/a','m/a/b','m/a/b/c','m/x']};
 },async({source:s,state,step,watching})=>{
  const t=T(s); const drop=(c)=>{state.contexts=state.contexts.filter(x=>x!==c); watching.invalidate();};
  await step('M01',()=>t('m/a/b/c/f.txt','f1'),1);
  await step('M02',()=>drop('m'),1);
  await step('M03',()=>t('m/a/b/c/g.txt','g'),1);
  await step('M04',()=>t('m/top.txt','t1'),1,'observe');
  await step('M05',()=>drop('m/a/b'),1);
  await step('M06',()=>t('m/a/b/h.txt','h'),1);
  await step('M07',()=>drop('m/a'),1);
  await step('M08',()=>t('m/a/b/i.txt','i'),1);
  await step('M09',()=>drop('m/x'),1);
  await step('M10',()=>t('m/a/b/j.txt','j'),1,'quiet');
  await step('M11',()=>t('m/a/b/c/k.txt','k'),1);
  await step('M12',()=>{state.contexts=['m/a/b/c','m']; watching.invalidate();},1);
  await step('M13',()=>t('m/a/b/l.txt','l'),1);
  await step('M14',()=>t('m/x/b/c/p.txt','p'),1);
 });
}
// Merge audit: removals and recreations of registered files and missing paths inside a context.
async function absentctx() {
 await session('absentctx',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'ctx/sub/f.txt'),'f',true); write(path.join(s,'ctx/keep.txt'),'k',true);
  return {contexts:['ctx'],files:['ctx/sub/f.txt'],missing:['ctx/sub/m.txt','ctx/new/deep/m2.txt']};
 },async({source:s,step})=>{
  const t=T(s);
  await step('R01',()=>fs.unlinkSync(path.join(s,'ctx/sub/f.txt')),1);
  await step('R02',()=>t('ctx/sub/f.txt','f2'),1);
  await step('R03',()=>t('ctx/sub/m.txt','m'),1);
  await step('R04',()=>fs.rmSync(path.join(s,'ctx/sub'),{recursive:true}),1);
  await step('R05',()=>t('ctx/sub/f.txt','f3'),1);
  await step('R06',()=>t('ctx/new/deep/m2.txt','m2'),1);
  await step('R07',()=>fs.unlinkSync(path.join(s,'ctx/new/deep/m2.txt')),1);
  await step('R08',()=>t('ctx/new/deep/m2.txt','m3'),1);
  await step('R09',()=>fs.rmSync(path.join(s,'ctx/new'),{recursive:true}),1);
  await step('R10',()=>t('ctx/sub/f.txt','f4'),1);
  await step('R11',()=>{fs.unlinkSync(path.join(s,'ctx/sub/f.txt')); t('ctx/sub/f.txt','f5');},1);
  await step('R12',()=>t('ctx/keep.txt','k2'),1);
  await step('R13',()=>fs.renameSync(path.join(s,'ctx/sub'),path.join(s,'away')),1);
  await step('R14',()=>t('ctx/keep.txt','k3'),1);
  await step('R15',()=>fs.renameSync(path.join(s,'away'),path.join(s,'ctx/sub')),1);
  await step('R16',()=>t('ctx/sub/f.txt','f6'),1);
 });
}
// Focus 4: the sticky no-alias flag. Add and remove an alias context while thousands of events are still queued.
async function sticky() {
 await session('sticky',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'realctx/a/x.txt'),'x',true);
  return {contexts:['realctx']};
 },async({source:s,state,step,watching})=>{
  const t=T(s); const burst=()=>{ for(let i=0;i<3000;i++) fs.writeFileSync(path.join(s,'realctx/a/hot.txt'),String(i)); };
  await step('S01',()=>t('realctx/a/n0.txt','n'),1);
  await step('S02',()=>{ burst(); fs.symlinkSync('realctx',path.join(s,'lctx')); state.contexts=['realctx','lctx']; watching.invalidate(); },1);
  await step('S03',()=>t('realctx/a/n1.txt','n'),1);
  await step('S04',()=>t('lctx/a/n2.txt','n'),1);
  await step('S05',()=>{ burst(); fs.unlinkSync(path.join(s,'lctx')); state.contexts=['realctx']; watching.invalidate(); },1);
  await step('S06',()=>t('realctx/a/n3.txt','n'),1);
  await step('S07',()=>{ burst(); fs.symlinkSync('realctx',path.join(s,'lctx')); state.contexts=['lctx']; watching.invalidate(); },1);
  await step('S08',()=>t('realctx/a/n4.txt','n'),1);
  await step('S09',()=>t('realctx/a/new/deep/n5.txt','n'),1);
 });
}
// New angle: create-then-delete churn while the initial context scan runs.
async function scanfuzz() {
 const N = +(process.env.FUZZ_DIRS || 3000), K = 40;
 let churnInfo;
 await session('scanfuzz',s=>{
  write(path.join(s,'index.js'),entry,true); W(s)('ctx/seed.js',0);
  for (let i=0;i<N;i++) { fs.mkdirSync(path.join(s,'ctx/big/d'+i+'/e'),{recursive:true}); }
  return {};
 },async({source:s,step})=>{
  console.log(JSON.stringify({type:'churn',...churnInfo}));
  const want={'./seed.js':0}; for (let i=0;i<K;i+=2) want['./churn/c'+i+'/y.js']=i;
  await step('FZ0',()=>W(s)('ctx/seed.js',0),{...want});
  // Each surviving churn directory must be watched on its own: one write per step.
  for (let i=0;i<K;i+=2) { want['./churn/c'+i+'/z.js']=i+1000; await step('FZ1-c'+i,()=>W(s)('ctx/churn/c'+i+'/z.js',i+1000),{...want}); }
  want['./big/d'+(N-1)+'/e/late.js']=7; await step('FZ2',()=>W(s)('ctx/big/d'+(N-1)+'/e/late.js',7),{...want});
  // Removed churn directories recreated later must be picked up too.
  want['./churn/c1/back.js']=9; await step('FZ3',()=>W(s)('ctx/churn/c1/back.js',9),{...want});
  want['./churn/c1/back2.js']=10; await step('FZ4',()=>W(s)('ctx/churn/c1/back2.js',10),{...want});
 },{noCounts:true, duringStart: async ({source:s,t0w}) => {
  const w=W(s); const start=Date.now(); const before=rawWatches(); let iters=0;
  for (let i=0;i<K;i++) {
   const d=path.join(s,'ctx/churn/c'+i);
   fs.mkdirSync(d,{recursive:true}); w('ctx/churn/c'+i+'/x.js',i); fs.mkdirSync(path.join(d,'inner'));
   await new Promise(r=>setImmediate(r));
   fs.rmSync(d,{recursive:true});
   await new Promise(r=>setImmediate(r));
   if (i%2===0) { fs.mkdirSync(d,{recursive:true}); w('ctx/churn/c'+i+'/y.js',i); }
   iters++;
   await sleep(10);
  }
  churnInfo={msAfterFirstBuild:start-t0w, churnMs:Date.now()-start, watchesBefore:before, watchesAfter:rawWatches(), iters};
 }});
}
// New angle: MultiCompiler, two compilers sharing one context directory.
async function multi() {
 const name='multi'; if (only && !only.has(name)) return;
 const source=path.join(root,name,'src'); fs.mkdirSync(source,{recursive:true});
 write(path.join(source,'a.js'),entry,true); write(path.join(source,'b.js'),entry.replace('./ctx','./ctx/x'),true); W(source)('ctx/x/f.js',1);
 const state={bContexts:['ctx']};
 const cfg=(n,extra)=>({name:n,context:source,mode:'development',target:'node',devtool:false,entry:'./'+n+'.js',resolve:{symlinks:false},
  output:{path:path.join(root,name,'out-'+n),filename:'bundle.js',library:{type:'commonjs2'}},experiments:{nativeWatcher:mode==='native'},plugins:extra?[extra]:[]});
 const compiler=rspack([cfg('a'),cfg('b',c=>c.hooks.thisCompilation.tap('adv',comp=>{for(const p of state.bContexts) comp.contextDependencies.add(path.join(source,p));}))]);
 let builds=0, pending; const per={a:0,b:0}; const errors=[];
 const next=(ms=4000)=>new Promise(res=>{const tm=setTimeout(()=>{pending=undefined;res(false);},ms); pending=()=>{clearTimeout(tm);pending=undefined;res(true);};});
 const first=next(60000);
 const watching=compiler.watch({aggregateTimeout:50,followSymlinks:true},(err,stats)=>{builds++; if(err||stats?.hasErrors()) errors.push(String(err||stats.toString()).slice(0,300)); for (const st of stats?.stats||[]) per[st.compilation.name]++; pending?.();});
 const out=n=>{try{const m={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(root,name,'out-'+n,'bundle.js'),'utf8'),{module:m,exports:m.exports});return JSON.parse(JSON.stringify(m.exports));}catch(e){return 'ERR:'+e.message;}};
 async function settled(){let n;do{n=builds;await sleep(300);}while(n!==builds);}
 async function step(id,change,wa,wb){await settled();const pb={...per};const b0=builds;const done=next();await change();const noticed=await done;await settled();
  const a=out('a'),b=out('b');let ok=noticed;try{assert.deepEqual(a,wa);assert.deepEqual(b,wb);}catch{ok=false;}
  const row={type:'row',label,mode,scenario:name,id,kind:'rebuild',ok,noticed,builds:builds-b0,perCompiler:{a:per.a-pb.a,b:per.b-pb.b},actual:{a,b},expected:{a:wa,b:wb},newErrors:errors.slice()}; results.push(row); console.log(JSON.stringify(row));
  if(!ok){const r=next();watching.invalidate();await r;await settled();}}
 try{ assert(await first,'initial build timed out'); identity(); await settled();
  const wa={'./x/f.js':1}, wb={'./f.js':1};
  wa['./x/g.js']=2; wb['./g.js']=2; await step('H01',()=>W(source)('ctx/x/g.js',2),{...wa},{...wb});
  wa['./x/deep/h.js']=3; wb['./deep/h.js']=3; await step('H02',()=>W(source)('ctx/x/deep/h.js',3),{...wa},{...wb});
  wa['./y/k.js']=4; await step('H03',()=>W(source)('ctx/y/k.js',4),{...wa},{...wb});
  state.bContexts=[]; await step('H04',()=>watching.invalidate(),{...wa},{...wb});
  wa['./y/deep/m.js']=5; await step('H05',()=>W(source)('ctx/y/deep/m.js',5),{...wa},{...wb});
  delete wa['./x/deep/h.js']; delete wb['./deep/h.js']; await step('H06',()=>fs.rmSync(path.join(source,'ctx/x/deep'),{recursive:true}),{...wa},{...wb});
  wa['./x/deep/n.js']=6; wb['./deep/n.js']=6; await step('H07',()=>W(source)('ctx/x/deep/n.js',6),{...wa},{...wb});
 } finally { await new Promise(r=>watching.close(()=>r())); }
}
// New angle: watch limit reached (run inside a user namespace with a lowered per-namespace limit).
async function limit() {
 const D=+(process.env.LIMIT_DIRS||40);
 await session('limit',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'other/f.txt'),'f',true);
  for (let i=0;i<D;i++) write(path.join(s,'ctx/d'+i+'/x.txt'),'x',true);
  return {contexts:['ctx'],files:['other/f.txt']};
 },async({source:s,state,step,watching})=>{
  const t=T(s);
  await step('N01',()=>t('ctx/d0/x.txt','x1'),1,'rebuild',12000);
  await step('N02',()=>t('ctx/d'+(D-1)+'/x.txt','x1'),1,'rebuild',12000);
  await step('N03',()=>{t('other2/g.txt','g'); state.files=['other/f.txt','other2/g.txt']; watching.invalidate();},1,'rebuild',12000);
  await step('N04',()=>t('other2/g.txt','g1'),1,'rebuild',12000);
  await step('N05',()=>t('other/f.txt','f1'),1,'rebuild',12000);
  await step('N06',()=>t('ctx/d1/x.txt','x2'),1,'rebuild',12000);
 },{noCounts:false});
}
// c3: recovery after the limit. Delete watched folders, then create a new one.
async function limitrec() {
 const D=+(process.env.LIMIT_DIRS||40);
 await session('limitrec',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'other/f.txt'),'f',true);
  for (let i=0;i<D;i++) write(path.join(s,'ctx/d'+i+'/x.txt'),'x',true);
  return {contexts:['ctx'],files:['other/f.txt']};
 },async({source:s,state,step,watching})=>{
  const t=T(s);
  await step('L01',()=>t('ctx/d0/x.txt','x1'),1,'rebuild',12000);
  await step('L02',()=>{ for (let i=0;i<Math.floor(D/2);i++) fs.rmSync(path.join(s,'ctx/d'+i),{recursive:true}); },1,'rebuild',12000);
  await step('L03',()=>t('ctx/new1/x.txt','n'),1,'rebuild',12000);
  await step('L04',()=>t('ctx/new1/x.txt','n2'),1,'rebuild',12000);
  await step('L05',()=>t('ctx/new1/y.txt','y'),1,'rebuild',12000);
  await step('L06',()=>{t('other2/g.txt','g'); state.files=['other/f.txt','other2/g.txt']; watching.invalidate();},1,'rebuild',12000);
  await step('L07',()=>t('other2/g.txt','g1'),1,'rebuild',12000);
  await step('L08',()=>t('ctx/d'+(D-1)+'/x.txt','x2'),1,'rebuild',12000);
  await step('L09',()=>t('other/f.txt','f1'),1,'rebuild',12000);
 });
}
// c3: a pattern that failed at the limit; is it retried after watches free up?
async function limitretry() {
 const D=+(process.env.LIMIT_DIRS||40);
 await session('limitretry',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'other/f.txt'),'f',true);
  for (let i=0;i<D;i++) write(path.join(s,'ctx/d'+i+'/x.txt'),'x',true);
  return {contexts:['ctx'],files:['other/f.txt']};
 },async({source:s,state,step,watching})=>{
  const t=T(s);
  await step('T01',()=>{t('other2/g.txt','g'); state.files=['other/f.txt','other2/g.txt']; watching.invalidate();},1,'rebuild',12000);
  await step('T02',()=>t('other2/g.txt','g1'),1,'rebuild',12000);
  await step('T03',()=>t('other/f.txt','f1'),1,'rebuild',12000);
  await step('T04',()=>{ for (let i=0;i<D;i++) fs.rmSync(path.join(s,'ctx/d'+i),{recursive:true}); },1,'rebuild',12000);
  await step('T05',()=>t('other/f.txt','f2'),1,'rebuild',12000);
  await step('T06',()=>t('other2/g.txt','g2'),1,'rebuild',12000);
  await step('T07',()=>t('other/f.txt','f3'),1,'rebuild',12000);
 });
}
// c3: a recursive analyzer pattern on an already watched context folder fails at the limit.
async function limitdrop() {
 const D=+(process.env.LIMIT_DIRS||40);
 await session('limitdrop',s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'ctx/p/a.txt'),'a',true); write(path.join(s,'ctx/p/q/b.txt'),'b',true);
  for (let i=0;i<D;i++) fs.mkdirSync(path.join(s,'ctx/p/ignored/i'+i),{recursive:true});
  return {contexts:['ctx']};
 },async({source:s,state,step,watching})=>{
  const t=T(s);
  await step('Q01',()=>t('ctx/p/a.txt','a1'),1,'rebuild',12000);
  await step('Q02',()=>{state.missing=['ctx/p/m1/m2/x.txt']; watching.invalidate();},1,'rebuild',12000);
  await step('Q03',()=>t('ctx/p/new.txt','n'),1,'rebuild',12000);
  await step('Q04',()=>t('ctx/p/a.txt','a2'),1,'rebuild',12000);
  await step('Q05',()=>t('ctx/p/q/b.txt','b1'),1,'rebuild',12000);
  await step('Q06',()=>t('ctx/p/a.txt','a3'),1,'rebuild',12000);
  await step('Q07',()=>{state.missing=[]; watching.invalidate();},1,'rebuild',12000);
  await step('Q08',()=>t('ctx/p/a.txt','a4'),1,'rebuild',12000);
 });
}
// c3: a folder main also watches (a registered context or a file's parent) gets a recursive
// analyzer pattern that fails at the limit.
async function limitdrop2(kind) {
 const D=+(process.env.LIMIT_DIRS||40);
 await session('limitdrop2-'+kind,s=>{
  write(path.join(s,'index.js'),one,true); write(path.join(s,'p/a.txt'),'a',true); write(path.join(s,'p/q/b.txt'),'b',true);
  for (let i=0;i<D;i++) fs.mkdirSync(path.join(s,'p/ignored/i'+i),{recursive:true});
  return kind==='ctx' ? {contexts:['p']} : {files:['p/a.txt']};
 },async({source:s,state,step,watching})=>{
  const t=T(s);
  await step('P01',()=>t('p/a.txt','a1'),1,'rebuild',12000);
  await step('P02',()=>{state.missing=['p/m1/m2/x.txt']; watching.invalidate();},1,'rebuild',12000);
  await step('P03',()=>t('p/a.txt','a2'),1,'rebuild',12000);
  await step('P04',()=>t('p/a.txt','a3'),1,'rebuild',12000);
  await step('P05',()=>{state.missing=[]; watching.invalidate();},1,'rebuild',12000);
  await step('P06',()=>t('p/a.txt','a4'),1,'rebuild',12000);
 });
}
const all = {
 'zunlink-true':()=>zunlink(true),'zunlink-false':()=>zunlink(false),'zlink-true':()=>zlink(true),'zlink-false':()=>zlink(false),
 sticky,'twin-true':()=>twin(true),'twin-false':()=>twin(false),outa,outperm,'ctxroot-true':()=>ctxroot(true),'ctxroot-false':()=>ctxroot(false),
 'ctxpair-true':()=>ctxpair(true),'ctxpair-false':()=>ctxpair(false),manyctx,absentctx,scanfuzz,multi,limit,limitrec,limitretry,limitdrop,'limitdrop2-ctx':()=>limitdrop2('ctx'),'limitdrop2-file':()=>limitdrop2('file'),
};
(async()=>{
 for (const [n,f] of Object.entries(all)) { if (n.startsWith("limit") && !(only && only.has(n))) continue; if (only && !only.has(n)) continue; await f(); }
 console.log(JSON.stringify({type:'summary',label,mode,rows:results.length,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).map(r=>r.scenario+':'+r.id),root}));
})().catch(err=>{console.error(err);process.exitCode=1;});
