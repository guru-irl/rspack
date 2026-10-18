import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const raw=path.resolve('bench-data/sw-error');
const fixture=path.join(raw,'parity-fixture');
const results=path.join(raw,'error-parity');
const bindings=JSON.parse(fs.readFileSync(path.join(raw,'bindings.json')));
const cases=['loader-throw','loader-callback','loader-reject','hook-reject','hook-resolve','js-fs'];
const gate=JSON.parse(fs.readFileSync(path.join(raw,'identity-accepted.json')));
if(!gate.accepted||JSON.stringify(gate.bindings)!==JSON.stringify(bindings))throw new Error('IDENTITY GATE: bindings have not both been accepted');
const armManifest={dir:path.resolve('bench-data/runtime')};
const require=createRequire(path.join(armManifest.dir,'package.json'));
function identity(binding){
 const real=fs.realpathSync(binding.path);
 if(createHash('sha256').update(fs.readFileSync(real)).digest('hex')!==binding.sha256)throw new Error('IDENTITY GATE: SHA mismatch');
 return real;
}
for(const b of Object.values(bindings))identity(b);
if(process.argv[2]==='child'){
 const [arm,which]=process.argv.slice(3);
 const expected=identity(bindings[arm]);
 const {rspack}=require('@rspack/core');
 const native=Object.keys(require.cache).filter(p=>p.endsWith('.node'));
 const maps=fs.readFileSync('/proc/self/maps','utf8').split('\n').filter(l=>l.endsWith(' '+expected));
 if(native.length!==1||fs.realpathSync(native[0])!==expected||!maps.length)throw new Error('IDENTITY GATE: loaded/map mismatch');
 const out=path.join(fixture,'out');fs.rmSync(out,{recursive:true,force:true});
 const calls={};let hookCalls=0;
 const compiler=rspack({mode:'development',context:fixture,entry:'./entry.js',cache:false,devtool:false,target:'node',output:{path:out,filename:'bundle.cjs'},optimization:{minimize:false,moduleIds:'named',chunkIds:'named'},module:{rules:which.startsWith('loader-')?[{test:/entry\.js$/,use:path.join(fixture,which+'.cjs')}]:[]},plugins:which.startsWith('hook-')?[{apply(c){c.hooks.emit.tapPromise('SingleWakeParity',async()=>{hookCalls++;await new Promise(r=>setImmediate(r));if(which==='hook-reject')throw new Error('single-wake-hook-reject');});}}]:[]});
 if(which==='js-fs'){
  const custom={};
  for(const key of Object.keys(fs))custom[key]=typeof fs[key]==='function'?fs[key].bind(fs):fs[key];
  for(const key of ['writeFile','mkdir','stat','open','write','close'])custom[key]=(...args)=>{calls[key]=(calls[key]||0)+1;return fs[key](...args);};
  compiler.outputFileSystem=custom;
 }
 const {error,stats}=await new Promise(resolve=>compiler.run((error,stats)=>resolve({error,stats})));
 const diagnostics=stats?stats.toJson({all:false,errors:true,warnings:true,errorDetails:true}):null;
 const fatal=error?{name:error.name,message:error.message,stack:error.stack,details:error.details??null}:null;
 if(which.startsWith('loader-')&&!(diagnostics?.errors?.length>0))throw new Error('Missing expected loader error');
 if(which==='hook-reject'&&!fatal)throw new Error('Missing expected hook rejection');
 if(['hook-resolve','js-fs'].includes(which)&&(fatal||diagnostics.errors.length||diagnostics.warnings.length))throw new Error('Unexpected successful-case diagnostics');
 if(which.startsWith('hook-')&&hookCalls!==1)throw new Error('Hook interceptor did not run');
 if(which==='js-fs'&&!(calls.writeFile>0||calls.write>0))throw new Error('Custom JS outputFileSystem did not write');
 const dest=path.join(results,arm,which);fs.mkdirSync(dest,{recursive:true});
 fs.writeFileSync(path.join(dest,'diagnostics.json'),JSON.stringify({fatal,diagnostics},null,2)+'\n');
 const files=[];
 function copy(dir,relative=''){
  if(!fs.existsSync(dir))return;
  for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   const rel=path.join(relative,e.name),file=path.join(dir,e.name);
   if(e.isDirectory())copy(file,rel);else{const data=fs.readFileSync(file);const to=path.join(dest,'files',rel);fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,data);files.push({name:rel,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
  }
 }
 copy(out);
 fs.writeFileSync(path.join(dest,'evidence.json'),JSON.stringify({which,arm,identity:{path:expected,sha256:bindings[arm].sha256,native,mappedSegments:maps.length},hookCalls,outputFsCalls:calls,files},null,2));
 await new Promise((resolve,reject)=>compiler.close(e=>e?reject(e):resolve()));
}else{
 fs.mkdirSync(fixture,{recursive:true});fs.mkdirSync(results,{recursive:true});
 fs.writeFileSync(path.join(fixture,'entry.js'),'module.exports = 42;\n');
 fs.writeFileSync(path.join(fixture,'loader-throw.cjs'),"module.exports = function(){throw new Error('single-wake-loader-throw');};\n");
 fs.writeFileSync(path.join(fixture,'loader-callback.cjs'),"module.exports = function(){this.async();setImmediate(()=>this.callback(new Error('single-wake-loader-callback')));};\n");
 fs.writeFileSync(path.join(fixture,'loader-reject.cjs'),"module.exports = async function(){throw new Error('single-wake-loader-reject');};\n");
 const attempts=[];
 for(const which of cases)for(const arm of ['control','treatment']){
  const p=spawnSync(process.execPath,[import.meta.filename,'child',arm,which],{env:{...process.env,BINDING_PATH:bindings[arm].path,NAPI_RS_NATIVE_LIBRARY_PATH:bindings[arm].path,TOKIO_WORKER_THREADS:'16'},encoding:'utf8',timeout:60000});
  attempts.push({which,arm,exit:p.status,signal:p.signal,error:p.error?.message});fs.writeFileSync(path.join(results,'attempts.json'),JSON.stringify(attempts,null,2));
  fs.writeFileSync(path.join(results,`${arm}-${which}.log`),(p.stdout||'')+'\n'+(p.stderr||''));
  if(p.status!==0||p.error)throw new Error(`Error-parity process failed ${arm}/${which}: ${p.stderr}`);
 }
 const certificate=[];
 for(const which of cases){
  const c=path.join(results,'control',which),t=path.join(results,'treatment',which);
  if(!fs.readFileSync(path.join(c,'diagnostics.json')).equals(fs.readFileSync(path.join(t,'diagnostics.json'))))throw new Error('ERROR PARITY FAIL: diagnostics '+which);
  const a=JSON.parse(fs.readFileSync(path.join(c,'evidence.json'))),b=JSON.parse(fs.readFileSync(path.join(t,'evidence.json')));
  if(JSON.stringify(a.files)!==JSON.stringify(b.files))throw new Error('OUTPUT PARITY FAIL: file list '+which);
  for(const file of a.files)if(!fs.readFileSync(path.join(c,'files',file.name)).equals(fs.readFileSync(path.join(t,'files',file.name))))throw new Error('OUTPUT PARITY FAIL: bytes '+which);
  certificate.push({which,diagnosticsByteIdentical:true,filesByteIdentical:true,files:a.files,controlFs:a.outputFsCalls,treatmentFs:b.outputFsCalls,hookCalls:a.hookCalls});
 }
 fs.writeFileSync(path.join(raw,'error-parity.json'),JSON.stringify({accepted:true,cases:certificate},null,2));console.log(JSON.stringify(certificate,null,2));
}
