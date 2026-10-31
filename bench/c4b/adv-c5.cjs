// Cycle-5 adversarial driver for PR #59 (89fdebef). Harness pieces copied from adv-c4.cjs.
// usage: node adv-c5.cjs <repo> <label> <native|watchpack> <binding sha256> [sessions,comma,separated]
const fs = require('node:fs');
const path = require('node:path');
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
const one='module.exports = 1;\n';
const D=+(process.env.LIMIT_DIRS||40), BIG=+(process.env.BIG_DIRS||10);

// Compilers in one process. defs: {name:{files,contexts,missing,setup(source)}}. kind: multi|sep|late.
async function mc(name, kind, defs, run) {
 if (only && !only.has(name)) return;
 fs.writeSync(2, `SESSION ${name} INIT\n`);
 const source=path.join(root,name,'src'); fs.mkdirSync(source,{recursive:true});
 const state={}; const per={}; const errors=[]; let builds=0, pending;
 for (const [n,d] of Object.entries(defs)) { write(path.join(source,n,'index.js'),one,true); d.setup?.(source); state[n]={files:[...(d.files||[])],contexts:[...(d.contexts||[])],missing:[...(d.missing||[])]}; per[n]=0; }
 const cfg=(n,gen='')=>({...(kind==='late'&&n==='c0'?{dependencies:['c1']}:{}),name:n,context:path.join(source,n),mode:'development',target:'node',devtool:false,entry:'./index.js',resolve:{symlinks:false},
  output:{path:path.join(root,name,'out-'+n+gen),filename:'bundle.js',library:{type:'commonjs2'}},experiments:{nativeWatcher:mode==='native'},
  plugins:[c=>c.hooks.done.tap('advDone',()=>{per[n]++;}),c=>c.hooks.thisCompilation.tap('adv',comp=>{const s=state[n]; for(const p of s.contexts) comp.contextDependencies.add(path.join(source,p)); for(const p of s.files) comp.fileDependencies.add(path.join(source,p)); for(const p of s.missing) comp.missingDependencies.add(path.join(source,p));})]});
 const onDone=(err,stats)=>{builds++; if(err||stats?.hasErrors()) errors.push(String(err||stats.toString()).slice(0,300)); pending?.();};
 const next=(ms=4000)=>new Promise(res=>{const tm=setTimeout(()=>{pending=undefined;res(false);},ms); pending=()=>{clearTimeout(tm);pending=undefined;res(true);};});
 // live: name -> {compiler, watching}; multi uses one MultiCompiler for all names.
 const live={}; let multi=null;
 function startSep(n,gen='') { const c=rspack(cfg(n,gen)); live[n]={compiler:c, watching:c.watch({aggregateTimeout:50,followSymlinks:true},onDone)}; }
 async function stopSep(n) { const l=live[n]; delete live[n]; await new Promise(r=>l.watching.close(()=>r())); await new Promise(r=>l.compiler.close(()=>r())); }
 const first=next(60000);
 if (kind==='multi'||kind==='late') { const c=rspack(Object.keys(defs).map(n=>cfg(n))); multi={compiler:c, watching:c.watch({aggregateTimeout:50,followSymlinks:true},onDone)}; }
 else for (const n of Object.keys(defs)) startSep(n);
 const invalidate=(names)=>{ if (multi) multi.watching.invalidate(); else for (const n of (names||Object.keys(live))) live[n]?.watching.invalidate(); };
 async function settled(){let n;const t=Date.now();do{n=builds;await sleep(400);}while(n!==builds&&Date.now()-t<15000);}
 const t=(p,v)=>write(path.join(source,p),v);
 // kind 'rebuild': every compiler in who must build; 'quiet': none may; 'observe': record only.
 async function step(id,who,change,skind='rebuild',wait=12000){
  const whos=[].concat(who); await settled(); fs.writeSync(2,`BEFORE ${name} ${id} raw=${rawWatches()}\n`);
  const pb={...per}; const b0=builds; const e0=errors.length; const raw0=rawWatches(); const t0=Date.now(); await change();
  if (skind==='rebuild') { while(whos.some(w=>per[w]===pb[w])&&Date.now()-t0<wait) await sleep(100); } else await sleep(wait);
  const tw=Date.now()-t0; await settled();
  const noticed=whos.every(w=>per[w]>pb[w]);
  const ok=skind==='observe'?true:skind==='quiet'?!whos.some(w=>per[w]>pb[w]):(noticed&&errors.length===e0);
  const row={type:'row',label,mode,scenario:name,id,kind:skind,who:whos.join('+'),ok,noticed,builds:builds-b0,perCompiler:Object.fromEntries(Object.keys(per).map(n=>[n,per[n]-pb[n]])),newErrors:errors.slice(e0),rawBefore:raw0,rawAfter:rawWatches(),msToNotice:tw,ms:Date.now()-t0};
  results.push(row); console.log(JSON.stringify(row));
  if(skind==='rebuild'&&!noticed){const r=next(12000);invalidate();await r;await settled();}
 }
 try { assert(await first,'initial build timed out'); identity(); await settled(); await sleep(1500); await settled();
  console.log(JSON.stringify({type:'row',label,mode,scenario:name,id:'INIT',kind:'observe',ok:true,raw:rawWatches(),errors:errors.slice()}));
  await run({source,state,step,t,invalidate,startSep,stopSep,settled,live});
 } finally {
  if (multi) await new Promise(r=>multi.watching.close(()=>r()));
  for (const n of Object.keys(live)) await stopSep(n);
 }
}
const ctxSetup=n=>s=>{ for (let i=0;i<D;i++) write(path.join(s,n,'ctx/d'+i+'/x.txt'),'x',true); };
const otherSetup=n=>s=>write(path.join(s,n,'other/f.txt'),'f',true);

// A1/A2: a recursive analyzer pattern (missing file two folders below an existing one) must add
// watches for folders created later. notify adds them from its event loop; a limit error there
// is only printed. Context-only watches from the same or another compiler hold the quota.
async function asyncrec(name, kind) {
 const both=kind==='single';
 const defs={c0:{files:['c0/other/f.txt'],missing:['c0/p/m1/m2/x.txt'],contexts:both?['c0/ctx']:[],setup:s=>{otherSetup('c0')(s); write(path.join(s,'c0/p/keep.txt'),'k',true); if(both) ctxSetup('c0')(s);}}};
 if (!both) defs.c1={files:['c1/other/f.txt'],contexts:['c1/ctx'],setup:s=>{otherSetup('c1')(s); ctxSetup('c1')(s);}};
 await mc(name, both?'sep':kind, defs, async({step,t})=>{
  await step('X01','c0',()=>t('c0/other/f.txt','f1'));
  await step('X02','c0',()=>fs.mkdirSync(path.join(root,name,'src','c0/p/m1/m2'),{recursive:true}),'observe',3000);
  await step('X03','c0',()=>t('c0/p/m1/m2/x.txt','x'));
  await step('X04','c0',()=>t('c0/other/f.txt','f2'));
  await step('X05','c0',()=>t('c0/p/m1/m2/x.txt','x1'));
  await step('X06','c0',()=>fs.mkdirSync(path.join(root,name,'src','c0/p/n1/n2'),{recursive:true}),'observe',3000);
 });
}
// A2: as A1, but a second missing file keeps the recursive pattern on c0/p. The new dependency
// folder c0/p/m1/m2 is then covered by that recursive pattern, so no separate native watch is
// added for it after the rebuild.
async function asyncrec2(name, kind) {
 const both=kind==='single';
 const defs={c0:{files:['c0/other/f.txt'],missing:['c0/p/m1/m2/x.txt','c0/p/z1/z2/y.txt'],contexts:both?['c0/ctx']:[],setup:s=>{otherSetup('c0')(s); write(path.join(s,'c0/p/keep.txt'),'k',true); if(both) ctxSetup('c0')(s);}}};
 if (!both) defs.c1={files:['c1/other/f.txt'],contexts:['c1/ctx'],setup:s=>{otherSetup('c1')(s); ctxSetup('c1')(s);}};
 await mc(name, both?'sep':kind, defs, async({step,t})=>{
  await step('Y01','c0',()=>t('c0/other/f.txt','f1'));
  await step('Y02','c0',()=>fs.mkdirSync(path.join(root,name,'src','c0/p/m1/m2'),{recursive:true}),'observe',3000);
  await step('Y03','c0',()=>t('c0/p/m1/m2/x.txt','x'));
  await step('Y04','c0',()=>t('c0/other/f.txt','f2'));
  await step('Y05','c0',()=>t('c0/p/m1/m2/x.txt','x1'));
  await step('Y06','c0',()=>t('c0/p/m1/m2/x.txt','x2'));
  await step('Y07','c0',()=>t('c0/other/f.txt','f3'));
 });
}
// S: one compiler's new dependency sits in another compiler's nested context folder.
async function share(name) {
 const defs={c0:{files:['c0/other/f.txt'],setup:otherSetup('c0')},c1:{files:['c1/other/f.txt'],contexts:['c1/ctx'],setup:s=>{otherSetup('c1')(s); ctxSetup('c1')(s);}}};
 await mc(name,'multi',defs,async({step,t,state,invalidate})=>{
  await step('S01','c0',()=>t('c0/other/f.txt','f1'));
  await step('S02','c0',()=>{state.c0.files.push('c1/ctx/d'+(D-1)+'/x.txt'); invalidate();});
  await step('S03','c0',()=>t('c1/ctx/d'+(D-1)+'/x.txt','x1'));
  await step('S04','c0',()=>{state.c0.files.push('c1/ctx/d3/x.txt'); invalidate();});
  await step('S05','c0',()=>t('c1/ctx/d3/x.txt','x1'));
  await step('S06','c1',()=>t('c1/ctx/x0.txt','top'));
  await step('S07','c0',()=>t('c1/ctx/d'+(D-1)+'/x.txt','x2'));
  await step('S08','c1',()=>t('c1/other/f.txt','f1'));
 });
}
// G: a restarted compiler while a peer that hit the limit stays alive, then after every watcher closed.
async function gen(name) {
 const defs={c0:{files:['c0/other/f.txt'],setup:otherSetup('c0')},c1:{files:['c1/other/f.txt'],contexts:['c1/ctx'],setup:s=>{otherSetup('c1')(s); ctxSetup('c1')(s);}}};
 await mc(name,'sep',defs,async({step,t,state,invalidate,startSep,stopSep})=>{
  await step('G01','c0',()=>{t('c0/other2/g.txt','g'); state.c0.files.push('c0/other2/g.txt'); invalidate(['c0']);});
  await step('G02','c0',()=>t('c0/other2/g.txt','g1'));
  await step('G03','c1',()=>t('c1/ctx/d1/x.txt','x1'));
  await stopSep('c1'); await sleep(500); startSep('c1','-g2'); await sleep(3000);
  await step('G04','c1',()=>t('c1/ctx/d2/x.txt','x1'));
  await step('G05','c1',()=>t('c1/other/f.txt','f1'));
  await step('G06','c0',()=>t('c0/other2/g.txt','g2'));
  await stopSep('c1'); await stopSep('c0'); await sleep(500); startSep('c1','-g3'); await sleep(3000);
  await step('G07','c1',()=>t('c1/ctx/d4/x.txt','x1'));
  await step('G08','c1',()=>t('c1/other/f.txt','f2'));
 });
}
// B: three compilers; c1 fills the quota with nested contexts; c0 and c2 hit the limit in the same
// rebuild, c2 with a large recursive registration.
async function busy(name) {
 const defs={
  c0:{files:['c0/other/f.txt'],setup:otherSetup('c0')},
  c1:{files:['c1/other/f.txt'],contexts:['c1/ctx'],setup:s=>{otherSetup('c1')(s); ctxSetup('c1')(s);}},
  c2:{files:['c2/other/f.txt'],setup:s=>{otherSetup('c2')(s); for(let i=0;i<BIG;i++) fs.mkdirSync(path.join(s,'c2/big/b'+i+'/c'),{recursive:true});}},
 };
 await mc(name,'multi',defs,async({step,t,state,invalidate})=>{
  for (const n of ['c0','c1','c2']) await step('B01-'+n,n,()=>t(n+'/other/f.txt','f1'));
  await step('B02',['c0','c2'],()=>{t('c0/other2/g.txt','g'); state.c0.files.push('c0/other2/g.txt'); state.c2.missing.push('c2/big/m1/m2/x.txt'); invalidate();});
  await step('B03','c0',()=>t('c0/other2/g.txt','g1'));
  await step('B04','c2',()=>fs.mkdirSync(path.join(root,name,'src','c2/big/m1/m2'),{recursive:true}),'observe',3000);
  await step('B05','c2',()=>t('c2/big/m1/m2/x.txt','x'));
  await step('B06','c2',()=>t('c2/big/b'+(BIG-1)+'/c/new.txt','n'),'quiet',2000);
  for (const n of ['c0','c1','c2']) await step('B07-'+n,n,()=>t(n+'/other/f.txt','f2'));
 });
}
const all = {
 'async-single':()=>asyncrec('async-single','single'),
 'async-multi':()=>asyncrec('async-multi','multi'),
 'async-sep':()=>asyncrec('async-sep','sep'),
 'async2-single':()=>asyncrec2('async2-single','single'),
 'async2-multi':()=>asyncrec2('async2-multi','multi'),
 'async2-sep':()=>asyncrec2('async2-sep','sep'),
 'share':()=>share('share'),
 'gen':()=>gen('gen'),
 'busy-r1':()=>busy('busy-r1'),'busy-r2':()=>busy('busy-r2'),'busy-r3':()=>busy('busy-r3'),
};
(async()=>{
 for (const [n,f] of Object.entries(all)) { if (only && !only.has(n)) continue; await f(); }
 console.log(JSON.stringify({type:'summary',label,mode,rows:results.length,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).map(r=>r.scenario+':'+r.id),root}));
})().catch(err=>{console.error(err);process.exitCode=1;});
