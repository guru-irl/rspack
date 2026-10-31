// Adversarial cycle-1 driver for PR #59 (353abbdd). Modeled on pr59-small/scripts/matrix-counted.cjs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const [repo, label, mode, wantedHash, onlyArg] = process.argv.slice(2);
assert(repo && label && ['native', 'watchpack'].includes(mode) && wantedHash);
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
 const sha = crypto.createHash('sha256').update(fs.readFileSync(mapped[0])).digest('hex');
 assert.equal(sha, wantedHash, 'wrong mapped binding');
 console.log(JSON.stringify({type:'identity', label, mode, binding:mapped[0], sha}));
 bindingChecked = true;
}
function write(p, contents, initial = false) {
 fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, contents);
 if (initial) { const past = new Date(Date.now() - 15000); fs.utimesSync(p, past, past); }
}
function counts(source) {
 const watches = new Set(); let raw=0;
 for (const fd of fs.readdirSync('/proc/self/fdinfo')) {
  let info; try { info = fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8'); } catch { continue; }
  for (const line of info.split('\n')) if (line.startsWith('inotify wd:')) { raw++; watches.add(BigInt('0x' + line.match(/ino:([0-9a-f]+)/)[1]).toString()); }
 }
 const seen=new Set(); let visible=0, ignored=0;
 function walk(dir) { let st; try { st=fs.statSync(dir,{bigint:true}); } catch { return; } if(!st.isDirectory()||seen.has(st.ino.toString())) return; seen.add(st.ino.toString());
  if(watches.has(st.ino.toString())) { if(dir.split(path.sep).includes('ignored')) ignored++; else visible++; }
  let names=[]; try { names=fs.readdirSync(dir); } catch {} for(const name of names) walk(path.join(dir,name));
 }
 walk(source); return {visible, ignored, total:watches.size, raw};
}
async function session(name, setup, run, followSymlinks=true) {
 if (only && !only.has(name)) return;
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
 let builds=0, errors=[], watching, pending;
 const output = () => { try { const module={exports:{}}; vm.runInNewContext(fs.readFileSync(path.join(out,'bundle.js'),'utf8'),{module, exports:module.exports}); return JSON.parse(JSON.stringify(module.exports)); } catch(e) { return 'ERR:'+e.message; } };
 function next(ms=4000) { assert(!pending); return new Promise(resolve=> {
  const timer=setTimeout(()=>{pending=undefined;resolve(false);},ms);
  pending=()=>{clearTimeout(timer);pending=undefined;resolve(true);};
 }); }
 const first=next(15000);
 watching=compiler.watch({aggregateTimeout:50,followSymlinks,ignored:/(?:^|\/)ignored(?:\/|$)/},(err,stats)=>{
  builds++; if(err || stats?.hasErrors()) errors.push(String(err||stats.toString()).slice(0,400)); pending?.();
 });
 let loops=0; async function settled() { let n; const t=Date.now(); do {n=builds; await sleep(250);} while(n!==builds && Date.now()-t<15000); if(n!==builds) { loops++; console.log(JSON.stringify({type:"unsettled",scenario:name,builds})); } }
 // kind: 'rebuild' (default) expects a build; 'quiet' expects none; 'observe' records only.
 async function step(id, change, expected, kind='rebuild') {
  await settled(); const before=builds, errBefore=errors.length; const done=kind==='rebuild'?next():null; const t0=Date.now(); change();
  let noticed;
  if(kind==='rebuild') noticed=await done; else { await sleep(1200); noticed=builds>before; }
  await settled(); const actual=output(); let outputOk=true;
  if(expected!==undefined) {try {assert.deepEqual(actual,expected);} catch {outputOk=false;} }
  const c=counts(source);
  const ok = kind==='observe' ? outputOk : (kind==='quiet' ? (!noticed && outputOk) : (noticed && outputOk));
  const row={type:'row',label,mode,scenario:name,followSymlinks,id,kind,ok,noticed,builds:builds-before,outputOk,actual,expected,newErrors:errors.slice(errBefore),counts:c,ms:Date.now()-t0};
  results.push(row); console.log(JSON.stringify(row));
  if((kind==='rebuild' && !noticed) || !outputOk) { const recovery=next(); try { watching.invalidate(); } catch(e) { row.recovery='invalidate threw '+e.message; } const r=await recovery; if(!r) console.log(JSON.stringify({type:'recovery-timeout',id})); await settled(); }
 }
 try { assert(await first,'initial build timed out'); identity(); await settled();
  const r0={type:'row',label,mode,scenario:name,followSymlinks,id:'INIT',kind:'observe',ok:true,actual:output(),errors:errors.slice(),counts:counts(source)}; console.log(JSON.stringify(r0));
  await run({source,state,step,output,watching}); }
 finally {await new Promise(res=>watching.close(()=>res())); await new Promise(res=>compiler.close(()=>res()));}
}
const entry='const c = require.context("./ctx", true, /\\.js$/); module.exports = Object.fromEntries(c.keys().sort().map(k => [k, c(k)]));\n';
const W=(s)=>(p,v)=>write(path.join(s,p),'module.exports = '+v+';\n');
async function identityS(follow) {
 await session('identity-'+follow,s=>{
  write(path.join(s,'index.js'),entry,true); W(s)('ctx/a/x.js',1); W(s)('ctx/c/y.js',2); fs.mkdirSync(path.join(s,'ctx/b'));
  W(s)('targets/one/sub/t.js',1); W(s)('targets/two/sub/t.js',2); W(s)('staging/f.js',7);
  fs.symlinkSync('../targets/one',path.join(s,'ctx/link'));
  for (const f of ['ctx/a/x.js','ctx/c/y.js','targets/one/sub/t.js','targets/two/sub/t.js','staging/f.js']) { const past=new Date(Date.now()-15000); fs.utimesSync(path.join(s,f),past,past); }
  return {};
 },async({source:s,step})=>{
  const w=W(s); const want={'./a-old/x.js':1,'./c/y.js':2,'./link/sub/t.js':1};
  await step('X01',()=>{fs.renameSync(path.join(s,'ctx/a'),path.join(s,'ctx/a-old'));fs.mkdirSync(path.join(s,'ctx/a'));},{...want});
  want['./a/new.js']=5; await step('X02',()=>w('ctx/a/new.js',5),{...want});
  want['./a-old/z.js']=6; await step('X03',()=>w('ctx/a-old/z.js',6),{...want});
  want['./b/f.js']=7; await step('X04',()=>fs.renameSync(path.join(s,'staging'),path.join(s,'ctx/b')),{...want});
  want['./b/g.js']=8; await step('X05',()=>w('ctx/b/g.js',8),{...want});
  want['./link/sub/t.js']=2; await step('Y01',()=>{fs.symlinkSync('../targets/two',path.join(s,'ctx/link.tmp'));fs.renameSync(path.join(s,'ctx/link.tmp'),path.join(s,'ctx/link'));},{...want});
  want['./link/sub/t.js']=3; await step('Y02',()=>w('targets/two/sub/t.js',3),{...want});
  await step('Y03',()=>w('targets/one/sub/t.js',9),{...want},'quiet');
  want['./link/sub/new.js']=4; await step('Y04',()=>w('targets/two/sub/new.js',4),{...want});
  delete want['./link/sub/new.js']; want['./link/sub/t.js']=9;
  await step('Y05',()=>{fs.unlinkSync(path.join(s,'ctx/link'));fs.symlinkSync('../targets/one',path.join(s,'ctx/link'));},{...want});
  want['./link/sub/t.js']=10; await step('Y06',()=>w('targets/one/sub/t.js',10),{...want});
  await step('Y07',()=>w('targets/two/sub/t.js',11),{...want},'quiet');
 },follow);
}
async function kmove(follow) {
 await session('kmove-'+follow,s=>{
  write(path.join(s,'index.js'),entry,true); write(path.join(s,'ctx/real/sub/a.js'),'module.exports = 1;\n',true);
  fs.symlinkSync('real',path.join(s,'ctx/link')); return {};
 },async({source:s,step})=>{
  const w=W(s); const want={'./real2/sub/a.js':1};
  await step('K01',()=>fs.renameSync(path.join(s,'ctx/real'),path.join(s,'ctx/real2')),{...want});
  want['./real2/sub/b.js']=2; await step('K02',()=>w('ctx/real2/sub/b.js',2),{...want});
  await step('K03',()=>fs.unlinkSync(path.join(s,'ctx/link')),{...want},'observe');
  want['./real2/sub/c.js']=3; await step('K04',()=>w('ctx/real2/sub/c.js',3),{...want});
  want['./real2/sub/a.js']=4; await step('K05',()=>w('ctx/real2/sub/a.js',4),{...want});
 },follow);
}
async function overlap(follow) {
 await session('overlap-'+follow,s=>{
  write(path.join(s,'index.js'),'module.exports = 1;\n',true); write(path.join(s,'area/real/sub/f.txt'),'f',true); write(path.join(s,'area/real/sub/deep/g.txt'),'g',true);
  fs.symlinkSync('real',path.join(s,'area/link'));
  return {contexts:['area/link/sub'],files:['area/real/sub/f.txt'],missing:['area/real/m1/m2/m3.txt']};
 },async({source:s,step})=>{
  const t=(p,v)=>write(path.join(s,p),v);
  await step('V01',()=>t('area/real/sub/f.txt','f1'),1);
  await step('V02',()=>t('area/real/sub/new.txt','n'),1);
  await step('V03',()=>t('area/real/sub/deep/new.txt','n'),1);
  await step('V04',()=>t('area/real/m1/m2/m3.txt','m'),1);
  await step('V05',()=>t('area/real/sub/f.txt','f2'),1);
  await step('V06',()=>t('area/real/sub/deep/new2.txt','n'),1);
  await step('V07',()=>fs.rmSync(path.join(s,'area/real/m1'),{recursive:true}),1);
  await step('V08',()=>t('area/real/sub/deep/new3.txt','n'),1);
  await step('V09',()=>fs.unlinkSync(path.join(s,'area/link')),1,'observe');
  await step('V10',()=>t('area/real/sub/f.txt','f3'),1);
  await step('V11',()=>t('area/real/sub/deep/new4.txt','n'),1,'observe');
 },follow);
}
async function perm() {
 await session('perm',s=>{
  write(path.join(s,'index.js'),'module.exports = 1;\n',true); write(path.join(s,'pc/open/a.txt'),'a',true); write(path.join(s,'pc/locked/b.txt'),'b',true);
  fs.chmodSync(path.join(s,'pc/locked'),0o000); return {contexts:['pc']};
 },async({source:s,step})=>{
  const t=(p,v)=>write(path.join(s,p),v);
  await step('P01',()=>t('pc/open/a.txt','a1'),1);
  await step('P02',()=>fs.chmodSync(path.join(s,'pc/locked'),0o755),1,'observe');
  await step('P03',()=>t('pc/locked/c.txt','c'),1);
  await step('P04',()=>t('pc/locked/b.txt','b1'),1);
  await step('P05',()=>t('pc/open/a.txt','a2'),1);
 });
}
async function permrec() {
 await session('permrec',s=>{
  write(path.join(s,'index.js'),'module.exports = 1;\n',true); write(path.join(s,'rc/a/a.txt'),'a',true); write(path.join(s,'rc/locked/b.txt'),'b',true);
  return {contexts:['rc'],missing:['rc/m1/m2/m.txt']};
 },async({source:s,step})=>{
  const t=(p,v)=>write(path.join(s,p),v);
  await step('Q01',()=>t('rc/a/a.txt','a1'),1);
  await step('Q02',()=>fs.chmodSync(path.join(s,'rc/locked'),0o000),1,'observe');
  await step('Q03',()=>t('rc/m1/m2/m.txt','m'),1);
  await step('Q04',()=>t('rc/a/a2.txt','a2'),1);
  await step('Q05',()=>fs.chmodSync(path.join(s,'rc/locked'),0o755),1,'observe');
  await step('Q06',()=>t('rc/a/a3.txt','a3'),1);
  await step('Q07',()=>t('rc/locked/c.txt','c'),1);
 });
}
async function loops(follow) {
 await session('loops-'+follow,s=>{
  write(path.join(s,'index.js'),'module.exports = 1;\n',true); write(path.join(s,'pc/sub/a.txt'),'a',true); write(path.join(s,'ignored/deep/z.txt'),'z',true); write(path.join(s,'top.txt'),'t',true);
  fs.symlinkSync('.',path.join(s,'pc/self')); fs.symlinkSync('..',path.join(s,'pc/up')); fs.symlinkSync('../../',path.join(s,'pc/sub/up2'));
  fs.symlinkSync('../ignored/deep',path.join(s,'pc/toign'));
  return {contexts:['pc']};
 },async({source:s,step})=>{
  const t=(p,v)=>write(path.join(s,p),v);
  await step('L01',()=>t('pc/sub/a.txt','a1'),1);
  await step('L02',()=>t('pc/sub/new.txt','n'),1);
  await step('L03',()=>t('ignored/deep/z.txt','z1'),1,'observe');
  await step('L04',()=>t('top.txt','t1'),1,'observe');
  await step('L05',()=>t('ignored/deep/new.txt','z2'),1,'observe');
 },follow);
}
async function races() {
 await session('races',s=>{
  write(path.join(s,'index.js'),entry,true); W(s)('ctx/seed.js',0); return {};
 },async({source:s,step})=>{
  const w=W(s); const want={'./seed.js':0};
  const deep=Array.from({length:40},(_,i)=>'d'+i).join('/');
  want['./r/'+deep+'/x.js']=1; await step('R02',()=>w('ctx/r/'+deep+'/x.js',1),{...want});
  const fan={}; for(let i=0;i<100;i++){ fan['./f/s'+i+'/x.js']=i; }
  Object.assign(want,fan); await step('R03',()=>{for(let i=0;i<100;i++) w('ctx/f/s'+i+'/x.js',i);},{...want});
  want['./f/s5/late.js']=55; await step('R04',()=>w('ctx/f/s5/late.js',55),{...want});
  want['./r/'+deep+'/y.js']=2; await step('R05',()=>w('ctx/r/'+deep+'/y.js',2),{...want});
 });
}
async function wlink(follow) {
 await session('wlink-'+follow,s=>{
  write(path.join(s,'index.js'),entry,true); write(path.join(s,'ctx/real/a.js'),'module.exports = 1;\n',true); fs.mkdirSync(path.join(s,'ctx/x'));
  fs.symlinkSync('../real',path.join(s,'ctx/x/link')); return {};
 },async({source:s,step})=>{
  const w=W(s); let want={'./real/a.js':1,'./x/link/a.js':1};
  want['./real/n1.js']=2; want['./x/link/n1.js']=2; await step('W01',()=>w('ctx/real/n1.js',2),{...want});
  want={'./real/a.js':1,'./real/n1.js':2}; await step('W02',()=>fs.unlinkSync(path.join(s,'ctx/x/link')),{...want});
  want['./real/n2.js']=3; await step('W03',()=>w('ctx/real/n2.js',3),{...want});
  for (const k of Object.keys(want)) want[k.replace('./real/','./x/link/')]=want[k];
  await step('W04',()=>fs.symlinkSync('../real',path.join(s,'ctx/x/link')),{...want});
  want['./real/n3.js']=4; want['./x/link/n3.js']=4; await step('W05',()=>w('ctx/real/n3.js',4),{...want});
  want={}; await step('W06',()=>fs.rmSync(path.join(s,'ctx/real'),{recursive:true}),{...want});
  want={'./real/n4.js':5,'./x/link/n4.js':5}; await step('W07',()=>w('ctx/real/n4.js',5),{...want});
  want['./real/n5.js']=6; want['./x/link/n5.js']=6; await step('W08',()=>w('ctx/real/n5.js',6),{...want});
 },follow);
}
async function zrec(follow) {
 await session('zrec-'+follow,s=>{
  write(path.join(s,'index.js'),'module.exports = 1;\n',true); write(path.join(s,'zr/real/f.txt'),'f',true); write(path.join(s,'zr/real/g.txt'),'g',true);
  fs.symlinkSync('real',path.join(s,'zr/link'));
  return {files:['zr/real/f.txt','zr/link/g.txt'],contexts:['zr/link'],missing:['zr/m1/m2/m.txt']};
 },async({source:s,step})=>{
  const t=(p,v)=>write(path.join(s,p),v);
  await step('Z01',()=>t('zr/real/f.txt','f1'),1);
  await step('Z02',()=>t('zr/real/g.txt','g1'),1);
  await step('Z03',()=>t('zr/real/new.txt','n'),1);
  await step('Z04',()=>t('zr/real/f.txt','f2'),1);
 },follow);
}
async function perm3() {
 await session('perm3',s=>{
  write(path.join(s,'index.js'),'module.exports = 1;\n',true); write(path.join(s,'pc/open/a.txt'),'a',true);
  for (const d of ['l1','l2','l3']) { write(path.join(s,'pc',d,'b.txt'),'b',true); fs.chmodSync(path.join(s,'pc',d),0o000); }
  return {contexts:['pc']};
 },async({source:s,step})=>{
  await step('T01',()=>write(path.join(s,'pc/open/a.txt'),'a1'),1);
 });
}
async function typeflip() {
 await session('typeflip',s=>{
  write(path.join(s,'index.js'),entry,true); W(s)('ctx/node/a.js',1); W(s)('ctx/keep/k.js',0); return {};
 },async({source:s,step})=>{
  const w=W(s); let want={'./keep/k.js':0,'./node.js':2};
  await step('F01',()=>{fs.rmSync(path.join(s,'ctx/node'),{recursive:true}); w('ctx/node.js',2); fs.writeFileSync(path.join(s,'ctx/node'),'plain file');},{...want});
  want={'./keep/k.js':0,'./node.js':2,'./node/b.js':3}; await step('F02',()=>{fs.unlinkSync(path.join(s,'ctx/node')); w('ctx/node/b.js',3);},{...want});
  want['./node/c.js']=4; await step('F03',()=>w('ctx/node/c.js',4),{...want});
  want['./node/deep/d.js']=5; await step('F04',()=>w('ctx/node/deep/d.js',5),{...want});
 });
}
async function rootmove() {
 await session('rootmove',s=>{
  write(path.join(s,'index.js'),entry,true); W(s)('ctx/sub/a.js',1); W(s)('ctx/sub/deep/b.js',2); return {};
 },async({source:s,step})=>{
  const w=W(s); let want={};
  await step('G01',()=>fs.renameSync(path.join(s,'ctx'),path.join(s,'ctx-away')),'ERR:any','observe');
  want={'./sub/a.js':1,'./sub/deep/b.js':2}; await step('G02',()=>fs.renameSync(path.join(s,'ctx-away'),path.join(s,'ctx')),{...want});
  want['./sub/new.js']=3; await step('G03',()=>w('ctx/sub/new.js',3),{...want});
  want['./sub/deep/new.js']=4; await step('G04',()=>w('ctx/sub/deep/new.js',4),{...want});
  want['./sub/deep/b.js']=5; await step('G05',()=>w('ctx/sub/deep/b.js',5),{...want});
 });
}
async function dangle() {
 await session('dangle',s=>{
  write(path.join(s,'index.js'),'module.exports = 1;\n',true); write(path.join(s,'rc/real/a.txt'),'a',true); write(path.join(s,'rc/x/seed.txt'),'s',true);
  fs.symlinkSync('../real',path.join(s,'rc/x/link'));
  return {contexts:['rc'],missing:['rc/m1/m2/m.txt']};
 },async({source:s,step})=>{
  const t=(p,v)=>write(path.join(s,p),v);
  await step('J01',()=>t('rc/x/seed.txt','s1'),1);
  await step('J02',()=>fs.rmSync(path.join(s,'rc/real'),{recursive:true}),1);
  await step('J03',()=>t('rc/m1/m2/m.txt','m'),1);
  await step('J04',()=>t('rc/x/new.txt','n'),1);
  await step('J05',()=>t('rc/x/seed.txt','s2'),1);
  await step('J06',()=>t('rc/top.txt','t'),1);
 },true);
}
(async()=>{
 await identityS(true); await identityS(false); await kmove(true); await kmove(false); await overlap(true); await overlap(false);
 await perm(); await permrec(); await loops(true); await loops(false); await races();
 await wlink(true); await wlink(false); await zrec(true); await zrec(false); await perm3(); await typeflip(); await rootmove(); await dangle();
 console.log(JSON.stringify({type:'summary',label,mode,rows:results.length,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).map(r=>r.scenario+':'+r.id),root}));
})().catch(err=>{console.error(err);process.exitCode=1;});
