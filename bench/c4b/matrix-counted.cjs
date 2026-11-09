const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const [repo, label, mode, wantedHash] = process.argv.slice(2);
assert(repo && label && ['native', 'watchpack'].includes(mode) && wantedHash);
const { rspack } = require(repo + '/packages/rspack/dist/index.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(process.env.ADV_BASE + "/" + label + "-");
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
 const watches = new Set(); let rawWatchCount=0, inotifyFDs=0;
 for (const fd of fs.readdirSync('/proc/self/fdinfo')) {
  let info; try { info = fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8'); } catch { continue; }
  if (info.includes('inotify wd:')) inotifyFDs++;
  for (const line of info.split('\n')) if (line.startsWith('inotify wd:')) { rawWatchCount++; watches.add(BigInt('0x' + line.match(/ino:([0-9a-f]+)/)[1]).toString()); }
 }
 let visible=0, ignored=0;
 function walk(dir) { const st=fs.lstatSync(dir, {bigint:true}); if(!st.isDirectory()) return;
  if(watches.has(st.ino.toString())) { if(dir.split(path.sep).includes('ignored')) ignored++; else visible++; }
  for(const name of fs.readdirSync(dir)) { const p=path.join(dir,name); if(fs.lstatSync(p).isDirectory()) walk(p); }
 }
 walk(source); return {visible, ignored, total:watches.size, rawWatchCount, inotifyFDs};
}
async function session(name, setup, run, followSymlinks=true) {
 const source=path.join(root,name,'src'), out=path.join(root,name,'out');
 fs.mkdirSync(source, {recursive:true}); const state=setup(source);
 const compiler=rspack({context:source, mode:'development', target:'node', devtool:false,
  entry:'./index.js', resolve:{symlinks:false},
  output:{path:out,filename:'bundle.js',library:{type:'commonjs2'}},
  experiments:{nativeWatcher:mode==='native'},
  plugins:[compiler=>compiler.hooks.thisCompilation.tap('matrix', compilation=> {
   for(const p of state.contexts || []) compilation.contextDependencies.add(path.join(source,p));
   for(const p of state.files || []) compilation.fileDependencies.add(path.join(source,p));
  })]
 });
 let builds=0, fatal, watching, pending;
 const output = () => { const module={exports:{}}; vm.runInNewContext(fs.readFileSync(path.join(out,'bundle.js'),'utf8'),{module, exports:module.exports}); return JSON.parse(JSON.stringify(module.exports)); };
 function next(ms=4000) { assert(!pending); return new Promise(resolve=> {
  const timer=setTimeout(()=>{pending=undefined;resolve(false);},ms);
  pending=()=>{clearTimeout(timer);pending=undefined;resolve(true);};
 }); }
 const first=next(15000);
 watching=compiler.watch({aggregateTimeout:50,followSymlinks,ignored:/(?:^|\/)ignored(?:\/|$)/},(err,stats)=>{
  builds++; if(err || stats?.hasErrors()) fatal=String(err||stats.toString()); pending?.();
 });
 async function settled() { let n; do {n=builds; await sleep(220);} while(n!==builds); if(fatal) throw Error(fatal); }
 async function step(id, change, expected, quiet=false, extra={}) {
  await settled(); const before=builds; const done=quiet?null:next(); change();
  const noticed=quiet?(await sleep(700),builds===before):await done;
  await settled(); const actual=output(); let outputOk=true;
  if(expected!==undefined) {try {assert.deepEqual(actual,expected);} catch {outputOk=false;} }
  const watchCounts=counts(source);
  const ok=noticed && outputOk && (!extra.noIgnored || watchCounts.ignored===0);
  const row={type:'row',label,mode,scenario:name,followSymlinks,id,ok,noticed,outputOk,actual,expected,counts:watchCounts};
  results.push(row); console.log(JSON.stringify(row));
  if(!noticed || !outputOk) { const recovery=next(); watching.invalidate(); assert(await recovery, 'forced recovery timed out'); await settled(); }
 }
 try { assert(await first,'initial build timed out'); if(fatal) throw Error(fatal); identity(); await settled(); await run({source,state,step,output,watching}); }
 finally {await new Promise((resolve,reject)=>watching.close(err=>err?reject(err):resolve())); await new Promise((resolve,reject)=>compiler.close(err=>err?reject(err):resolve()));}
}
const entry='const c = require.context("./ctx", true, /\\.js$/); module.exports = Object.fromEntries(c.keys().sort().map(k => [k, c(k)]));\n';
async function existing() {
 await session('existing',s=>{
  write(path.join(s,'index.js'),entry,true); write(path.join(s,'ctx/existing/seed.txt'),'seed',true);
  write(path.join(s,'plugin/nested/seed.txt'),'before',true);write(path.join(s,'plugin/kept/deep/file.txt'),'kept',true);
  write(path.join(s,'other/file.txt'),'watched',true); fs.mkdirSync(path.join(s,'ctx/real/sub'),{recursive:true}); fs.symlinkSync('real',path.join(s,'ctx/link'));
  return {contexts:['plugin','plugin/kept'],files:['plugin/kept/deep/file.txt','other/file.txt']};
 },async({source:s,state,step,watching})=>{
  let want={}; const add=(p,v)=>{want[p]=v;}; const w=(p,v)=>write(path.join(s,p),'module.exports = '+v+';\n');
  add('./existing/new.js',1);await step('E01',()=>w('ctx/existing/new.js',1),want);
  await step('E02',()=>fs.mkdirSync(path.join(s,'ctx/created')),want);
  add('./created/later.js',2);await step('E03',()=>w('ctx/created/later.js',2),want);
  await step('E04',()=>write(path.join(s,'plugin/nested/new.txt'),'new'),want);
  await step('E05',()=>write(path.join(s,'plugin/nested/seed.txt'),'after'),want);
  state.contexts=['plugin/kept']; await step('E06',()=>watching.invalidate(),want);
  await step('E07',()=>write(path.join(s,'plugin/nested/unused.txt'),'unused'),want,true);
  await step('E08',()=>write(path.join(s,'plugin/kept/deep/file.txt'),'changed'),want);
  add('./link/sub/a.js',3);add('./real/sub/a.js',3);await step('E09',()=>w('ctx/real/sub/a.js',3),want);
  await step('E10',()=>{fs.rmSync(path.join(s,'ctx/real/sub'),{recursive:true});w('ctx/real/sub/a.js',3);},want);
  add('./link/sub/recreated.js',6);add('./real/sub/recreated.js',6);await step('E11',()=>w('ctx/real/sub/recreated.js',6),want);
  delete want['./link/sub/a.js'];delete want['./link/sub/recreated.js'];await step('E12',()=>fs.unlinkSync(path.join(s,'ctx/link')),want);
  add('./real/sub/b.js',3);await step('E13',()=>w('ctx/real/sub/b.js',3),want);
  add('./real/c.js',4);await step('E14',()=>w('ctx/real/c.js',4),want);
  await step('E15',()=>{fs.renameSync(path.join(s,'other'),path.join(s,'ctx/moved'));write(path.join(s,'other/file.txt'),'recreated');},want);
  add('./moved/new.js',5);await step('E16',()=>w('ctx/moved/new.js',5),want);
  add('./a/b/c/race.js',7);await step('R01',()=>w('ctx/a/b/c/race.js',7),want);
  delete want['./a/b/c/race.js'];add('./a/b/c/back.js',8);
  await step('D01',()=>{fs.rmSync(path.join(s,'ctx/a'),{recursive:true});w('ctx/a/b/c/back.js',8);},want);
  add('./a/b/c/next.js',12);await step('D02',()=>w('ctx/a/b/c/next.js',12),want);
  write(path.join(s,'incoming/sub/in.js'),'module.exports = 9;\n',true);add('./incoming/sub/in.js',9);
  await step('M01',()=>fs.renameSync(path.join(s,'incoming'),path.join(s,'ctx/incoming')),want);
  delete want['./incoming/sub/in.js'];await step('M02',()=>fs.renameSync(path.join(s,'ctx/incoming'),path.join(s,'outgoing')),want);
  want={'./fresh/deep/a.js':10};await step('C01',()=>{fs.rmSync(path.join(s,'ctx'),{recursive:true});w('ctx/fresh/deep/a.js',10);},want);
  add('./fresh/deep/b.js',11);await step('C02',()=>w('ctx/fresh/deep/b.js',11),want);
 });
}
async function ignoredOverlap() {
 await session('ignored-overlap',s=>{
  write(path.join(s,'index.js'),'module.exports = 1;\n',true);write(path.join(s,'ctx/sub/x.js'),'one',true);
  for(let i=0;i<8;i++)write(path.join(s,'ctx/ignored/d'+i+'/deep/x.js'),'ignore',true);
  return {contexts:['ctx','ctx/sub']};
 },async({source:s,state,step,watching})=>{
  await step('I01',()=>write(path.join(s,'ctx/ignored/d0/deep/x.js'),'edit'),1,true,{noIgnored:true});
  await step('I02',()=>write(path.join(s,'ctx/ignored/new/deep/x.js'),'new'),1,true,{noIgnored:true});
  state.contexts=['ctx']; await step('O00',()=>watching.invalidate(),1);
  await step('O01',()=>write(path.join(s,'ctx/sub/x.js'),'two'),1);
 });
}
async function aliases(follow) {
 await session('aliases-'+follow,s=>{
  write(path.join(s,'index.js'),entry,true);write(path.join(s,'ctx/real/sub/a.js'),'module.exports = 1;\n',true);
  fs.symlinkSync('real',path.join(s,'ctx/link')); return {};
 },async({source:s,step})=>{
  let want={'./link/sub/a.js':2,'./real/sub/a.js':2};
  await step(follow?'S03':'S01',()=>write(path.join(s,'ctx/real/sub/a.js'),'module.exports = 2;\n'),want);
  await step(follow?'S03a':'S01a',()=>fs.unlinkSync(path.join(s,'ctx/link')),{'./real/sub/a.js':2});
  await step(follow?'S04':'S02',()=>write(path.join(s,'ctx/real/sub/a.js'),'module.exports = 3;\n'),{'./real/sub/a.js':3});
  await step(follow?'S04a':'S02a',()=>write(path.join(s,'ctx/real/sub/a.js'),'module.exports = 4;\n'),{'./real/sub/a.js':4});
 },follow);
}
(async()=>{ await existing();await ignoredOverlap();await aliases(false);await aliases(true);
 console.log(JSON.stringify({type:'summary',label,mode,rows:results.length,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).map(r=>r.id),root}));
})().catch(err=>{console.error(err);process.exitCode=1;});
