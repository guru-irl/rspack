import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recordRestartShutdown } from './restart-shutdown.mjs';
export async function checkShutdown(work) {
 const observer=recordRestartShutdown();
 const close=server=>()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 try {
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await observer.restart(close(server));
  await observer.final(close(server));
  assert.equal(observer.records.filter(r=>r.tolerated).length,1);
  await assert.rejects(observer.final(close(createServer())),/only tolerate a server already closed/);
  await assert.rejects(observer.restart(close(server)),{code:'ERR_SERVER_NOT_RUNNING'});
  await assert.rejects(observer.final(async()=>{throw Object.assign(new Error('unobserved'),{code:'ERR_SERVER_NOT_RUNNING'});}),/observed close callback/);
  await assert.rejects(observer.final(async()=>{throw Object.assign(new Error('other'),{code:'OTHER'});}),{code:'OTHER'});
  fs.writeFileSync(path.join(work,'restart-shutdown-check.json'),JSON.stringify({passed:true,checks:['recorded-restart-final-only','unrecorded-server-rejected','restart-errors-not-tolerated','unobserved-error-rejected','other-error-rejected']},null,2));
 } finally {observer.restore();}
}
