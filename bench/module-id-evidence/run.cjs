'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = __dirname;
const nativeName = {linux:'rspack.linux-x64-gnu.node',darwin:'rspack.darwin-arm64.node',win32:'rspack.win32-x64-msvc.node'}[process.platform];
if (!nativeName) throw new Error('Unsupported platform');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const binaries = Object.fromEntries(['base','pr'].map(arm => [arm, path.join(root,'build',arm,nativeName)]));
const hashes = Object.fromEntries(Object.entries(binaries).map(([arm,p])=>[arm,sha(p)]));
if (hashes.base === hashes.pr) throw new Error('Identical native arms');
const declared = JSON.parse(fs.readFileSync(path.join(root,'build/identity.json')));
for (const arm of ['base','pr']) {
  if (hashes[arm] !== declared[arm]) throw new Error('Downloaded binary identity mismatch');
  const expectedSource = arm === 'base' ? '96dcd72db4d25a89c37d22d514285ab82fc46a3d' : '57b7614aaca0f58b7667e370516c6ac1b1dffa56';
  if (fs.readFileSync(path.join(root,'build',arm,'source.txt'),'utf8').trim() !== expectedSource) throw new Error('Source identity mismatch');
}
const data = path.join(root,'data');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'metadata.json'),JSON.stringify({at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,cpus:os.cpus(),ram:os.totalmem(),release:os.release(),hashes,runnerImage:process.env.ImageOS,runnerVersion:process.env.ImageVersion,buildRun:process.env.BUILD_RUN},null,2));
function sample(family,block) {
  if (Date.now() >= Date.parse('2026-10-17T00:55:00Z')) throw new Error('Measurement deadline reached');
  const arm = family.startsWith('base') ? 'base' : 'pr';
  const tag = `block-${block}-${family}`;
  const log = fs.openSync(path.join(data,tag+'.log'),'wx');
  const env = {...process.env, ARM_LABEL:arm, MODULE_IDS:'compact-hashed',TRIALS:'1',TRIAL_INDEX:String(block),BENCH_TAG:tag,NAPI_RS_NATIVE_LIBRARY_PATH:binaries[arm],EXPECTED_NATIVE_SHA:hashes[arm],VERIFY_INCREMENTAL:arm==='pr'?'1':'0',CONTENT_ONLY:process.platform==='linux'?'0':'1'};
  const child = spawnSync(process.execPath,['--expose-gc',path.join(root,'benchmark.cjs')],{env,stdio:['ignore',log,log],timeout:300000});
  fs.closeSync(log);
  if (child.error || child.status !== 0) {
    console.error(fs.readFileSync(path.join(data,tag+'.log'),'utf8').split('\n').slice(-100).join('\n'));
    throw new Error(`Failed ${tag}: ${child.error || child.status}`);
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(data,tag,'complete.json')));
  if (receipt.nativeSha256 !== hashes[arm] || receipt.nativeLoads !== 1 || receipt.rows !== (process.platform==='linux'?9:7)) throw new Error('Invalid receipt');
  fs.appendFileSync(path.join(data,'schedule.jsonl'),JSON.stringify({family,arm,block,tag,receipt})+'\n');
  console.log(`COMPLETE ${tag}`);
}
// One discarded process warmup per build, before fixed-protocol measurements.
sample('base-warmup',0); sample('pr-warmup',0);
for(let block=1;block<=10;block++) {
  let order;
  if(process.platform==='linux') {
    const orders = [['base1','base2','pr1','pr2'],['pr2','pr1','base2','base1'],['base2','pr2','pr1','base1'],['pr1','base1','base2','pr2']];
    order=orders[(block-1)%orders.length];
  } else order=block%2?['base','pr']:['pr','base'];
  for(const family of order) sample(family,block);
}
fs.writeFileSync(path.join(data,'run-complete.json'),JSON.stringify({hashes,at:new Date().toISOString(),blocks:10}));
