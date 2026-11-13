const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const [repoArg, label] = process.argv.slice(2);
const repo = fs.realpathSync(repoArg);
process.env.ALIAS_SOURCE_ROOT = repo;
const verified = require('../alias-xplat/binding-guard.cjs');
const { rspack } = require(repo + '/packages/rspack/dist/index.js');
assert(verified(), 'Native binding did not load');
const wait = ms => new Promise(r => setTimeout(r, ms));
const rows = [];
function write(file, value) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, value); }
async function run(direction, followSymlinks) {
 const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.OWNERSHIP_BASE, label + '-')));
 const real = path.join(root, 'target');
 const alias = path.join(root, direction === 'forward' ? 'ctx/link' : 'outside/link');
 write(path.join(real, 'sub/a.js'), 'module.exports = 0;');
 fs.mkdirSync(path.dirname(alias), {recursive:true});
 fs.symlinkSync(process.platform === 'win32' ? real : path.relative(path.dirname(alias), real), alias, 'junction');
 const imported = path.join(direction === 'forward' ? real : alias, 'sub/a.js');
 write(path.join(root, 'index.js'), 'module.exports = require(' + JSON.stringify(imported) + ');');
 let outer = true, builds = 0, error, value;
 const compiler = rspack({context:root,mode:'development',target:'node',devtool:false,entry:'./index.js',resolve:{symlinks:false},output:{path:path.join(root,'out'),filename:'bundle.js',library:{type:'commonjs2'}},experiments:{nativeWatcher:true},plugins:[c=>c.hooks.thisCompilation.tap('ownership',comp=>{if(outer)comp.contextDependencies.add(direction === 'forward' ? path.join(root,'ctx') : real);})]});
 const watching = compiler.watch({aggregateTimeout:30,followSymlinks},(e,s)=>{builds++; error=e || (s?.hasErrors()?new Error(s.toString()):undefined); if(!error){const module={exports:{}}; vm.runInNewContext(s.compilation.assets['bundle.js'].source().toString(), {module});value=module.exports;}});
 async function until(predicate, ms=4000) { const end=Date.now()+ms; while(!predicate()&&Date.now()<end) await wait(20); return predicate(); }
 async function settle(){const end=Date.now()+4000;let b;do{b=builds;await wait(300);}while(b!==builds&&Date.now()<end);}
 try {
  assert(await until(()=>builds>0)); assert.ifError(error); assert.equal(value,0);
  for(const [id,want] of [['owned',1],['released',2]]){
   if(id==='released'){outer=false;const before=builds;watching.invalidate();assert(await until(()=>builds>before));await settle();}
   await settle();const before=builds;write(path.join(real,'sub/a.js'),'module.exports = '+want+';');
   const noticed=await until(()=>builds>before && value===want);
   const row={type:'row',label,direction,followSymlinks,id,noticed,value,want,error:error?String(error):null};rows.push(row);console.log(JSON.stringify(row));
   if(!noticed){const b=builds;watching.invalidate();assert(await until(()=>builds>b));await settle();}
  }
 } finally { await new Promise((r,j)=>watching.close(e=>e?j(e):r())); await new Promise((r,j)=>compiler.close(e=>e?j(e):r())); }
 console.log(JSON.stringify({type:'closed',label,direction,followSymlinks}));
}
(async()=>{for(const dir of ['forward','reverse'])for(const follow of [false,true])await run(dir,follow);console.log(JSON.stringify({type:'summary',label,rows:rows.length,passed:rows.filter(r=>r.noticed&&!r.error&&r.value===r.want).length}));})().catch(e=>{console.error(e);process.exitCode=1;});
