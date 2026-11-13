const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const pin = fs.realpathSync.native(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
const digest = crypto.createHash('sha256'), chunk = Buffer.alloc(1024*1024);
const fd = fs.openSync(pin,'r');
try { for(let bytes; (bytes=fs.readSync(fd,chunk,0,chunk.length,null))>0;)digest.update(chunk.subarray(0,bytes)); } finally { fs.closeSync(fd); }
const sha = digest.digest('hex');
assert.equal(sha,process.env.EXPECTED_BINDING_SHA256);
let loaded=false;
const dlopen=process.dlopen;
process.dlopen=function(module,filename,...args){const result=dlopen.call(this,module,filename,...args);if(fs.realpathSync.native(filename)===pin)loaded=true;return result;};
const binding=require(pin);
assert(loaded,'Intended binding did not load');
if(process.platform==='linux')assert(fs.readFileSync('/proc/self/maps','utf8').includes(pin));
console.log(JSON.stringify({type:'identity',sha,binding:pin,proof:process.platform==='linux'?'maps':'dlopen'}));
module.exports={binding,sha,pin};
