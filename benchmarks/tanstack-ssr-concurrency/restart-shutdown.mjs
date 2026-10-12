import { Server } from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Only the restart harness uses this observer. No bundler or plugin code changes.
export function recordRestartShutdown(file) {
 const original=Server.prototype.close;
 const closedByRestart=new WeakSet();
 const ids=new WeakMap();
 const records=[];
 let nextId=0,phase='idle';
 const save=()=>{if(file)fs.writeFileSync(file,JSON.stringify(records,null,2));};
 Server.prototype.close=function(...args) {
  const server=this,callPhase=phase,wasListening=server.listening;
  if(!ids.has(server))ids.set(server,++nextId);
  const id=ids.get(server);
  const i=args.findIndex(arg=>typeof arg==='function');
  if(i>=0) {
   const callback=args[i];
   args[i]=function(error,...rest) {
    if(callPhase==='restart'&&wasListening&&!error&&!server.listening)closedByRestart.add(server);
    records.push({id,phase:callPhase,wasListening,listening:server.listening,recordedRestartClose:closedByRestart.has(server),error:error?.code,stack:error?.stack,t:performance.now()});
    save();return callback.call(this,error,...rest);
   };
  }
  return original.apply(server,args);
 };
 const inPhase=async(value,fn)=>{phase=value;try{return await fn();}finally{phase='idle';}};
 return {
  records,
  restart:fn=>inPhase('restart',fn),
  final:fn=>inPhase('final',async()=>{
   const from=records.length;
   try{return await fn();}catch(error){
    if(error.code!=='ERR_SERVER_NOT_RUNNING')throw error;
    const matching=records.slice(from).filter(r=>r.phase==='final'&&r.error===error.code);
    assert.ok(matching.length>0,'final shutdown error must have an observed close callback');
    assert.ok(matching.every(r=>!r.wasListening&&!r.listening&&r.recordedRestartClose),'only tolerate a server already closed by the recorded restart close');
    records.push({phase:'final',tolerated:true,error:error.code,serverIds:matching.map(r=>r.id),stack:error.stack,t:performance.now()});
    save();console.log('[restart-shutdown]',JSON.stringify(records.at(-1)));
   }
  }),
  restore:()=>{Server.prototype.close=original;}
 };
}
