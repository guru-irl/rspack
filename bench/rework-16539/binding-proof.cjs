if (process.platform === 'linux') {
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { threadId } = require('node:worker_threads');
const expected = fs.realpathSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
require(path.join(path.dirname(expected), 'binding.js'));
const mapped = [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n')
  .map(line => line.match(/\s(\/.*\.node)$/)?.[1]).filter(Boolean))]
  .filter(file => path.basename(file).startsWith('rspack.'));
if (mapped.length !== 1 || fs.realpathSync(mapped[0]) !== expected) {
  throw new Error(`Wrong mapped binding: ${JSON.stringify(mapped)}, expected ${expected}`);
}
const hash = crypto.createHash('sha256').update(fs.readFileSync(mapped[0])).digest('hex');
if (hash !== process.env.EXPECTED_BINDING_SHA256) throw new Error(`Wrong binding hash: ${hash}`);
if (process.env.BINDING_PROOF_DIR) {
  fs.mkdirSync(process.env.BINDING_PROOF_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.BINDING_PROOF_DIR, `${process.pid}-${threadId}.json`), JSON.stringify({
    pid: process.pid, threadId, sourceSha: process.env.TASK_SOURCE_SHA, sourceTree: process.env.TASK_SOURCE_TREE,
    sha256: hash, binding: mapped[0], proof: 'maps'
  }));
}
console.error(`BINDING_PROOF pid=${process.pid} sha256=${hash} path=${mapped[0]}`);

} else {
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{threadId}=require('node:worker_threads');
const expected=fs.realpathSync.native(process.env.NAPI_RS_NATIVE_LIBRARY_PATH||process.env.TASK_BINDING_PATH),norm=p=>process.platform==='win32'?p.toLowerCase():p;
let loaded=false;const dlopen=process.dlopen;process.dlopen=function(module,file,...args){const result=dlopen.call(this,module,file,...args);if(norm(fs.realpathSync.native(file))===norm(expected))loaded=true;return result;};
require(path.join(path.dirname(expected),'binding.js'));
const objects=process.report.getReport().sharedObjects.filter(p=>/rspack.*\.node$/i.test(path.basename(p))).map(p=>fs.realpathSync.native(p));assert(objects.every(p=>norm(p)===norm(expected)),'other rspack binding loaded');assert(loaded||objects.some(p=>norm(p)===norm(expected)),'expected binding not loaded');
const hash=crypto.createHash('sha256');const fd=fs.openSync(expected,'r'),buffer=Buffer.allocUnsafe(1024*1024);try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,count));}finally{fs.closeSync(fd);}
const sha256=hash.digest('hex');assert.equal(sha256,process.env.EXPECTED_BINDING_SHA256);
const receipt={pid:process.pid,threadId,sourceSha:process.env.TASK_SOURCE_SHA,sourceTree:process.env.TASK_SOURCE_TREE,sha256,binding:expected,proof:loaded?'dlopen':'sharedObjects'};process.stderr.write('BINDING_PROOF '+JSON.stringify(receipt)+'\n');if(process.env.BINDING_PROOF_DIR){fs.mkdirSync(process.env.BINDING_PROOF_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.BINDING_PROOF_DIR,`${process.pid}-${threadId}.json`),JSON.stringify(receipt));}

}
