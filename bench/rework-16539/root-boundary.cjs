const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [repoArg, label, out] = process.argv.slice(2);
const repo = fs.realpathSync(repoArg);
process.env.ALIAS_SOURCE_ROOT = repo;
const verified = require('../alias-xplat/binding-guard.cjs');
const { NativeWatcher } = require(path.join(repo, 'crates/node_binding/binding.js'));
assert(verified(), 'Native binding did not load');
const wait = ms => new Promise(r => setTimeout(r, ms));
const rows = [];
(async () => {
 for (const followSymlinks of [false, true]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR, 'boundary-')));
  const ctx = path.join(root, 'ctx');
  const entry = path.join(ctx, 'one/index.js');
  fs.mkdirSync(path.dirname(entry), { recursive:true }); fs.writeFileSync(entry, '0');
  fs.mkdirSync(path.join(ctx,'existing')); fs.writeFileSync(path.join(ctx,'existing/seed.txt'),'seed');
  const batches = [], errors = [];
  const watcher = new NativeWatcher({aggregateTimeout:20,followSymlinks});
  watcher.watch([[entry],[]], [[ctx],[]], [[path.join(ctx,'one/missing/deep/a.js')],[]], BigInt(Date.now()-10000),
    (error,batch) => { if(error)errors.push(String(error)); else batches.push(batch); }, () => {});
  try {
   await wait(700);
   for(const id of ['existing','sibling']) {
    batches.length=0;
    if(id==='sibling')fs.mkdirSync(path.join(ctx,id));
    fs.writeFileSync(path.join(ctx,id,'new.js'),'1');
    const end=Date.now()+4000;
    while(!batches.some(b=>b.changedFiles.includes(ctx))&&Date.now()<end)await wait(20);
    rows.push({type:'row',label,followSymlinks,id,noticed:batches.some(b=>b.changedFiles.includes(ctx)),errors:[...errors]});
    await wait(300);
   }
  } finally { await watcher.close(); }
 }
 const receipt={label,rows,binding:process.env.EXPECTED_BINDING_SHA256};
 fs.writeFileSync(out,JSON.stringify(receipt)); console.log(JSON.stringify(receipt));
})().catch(error=>{console.error(error);process.exitCode=1;});
