'use strict';
const assert=require('node:assert/strict');
const os=process.argv[2];assert(['Linux','macOS','Windows'].includes(os));
const token=process.env.GH_TOKEN;assert(token,'read-only action token required');
const headers={Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28'};
const api=async endpoint=>{const r=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/41106150672/${endpoint}`,{headers});assert(r.ok,`build receipt API ${r.status}`);return r.json();};
(async()=>{
 let previous='';
 for(;;){
  assert(Date.now()<Date.parse('2026-10-31T02:30:00Z'),'not enough time remains to begin a full matrix');
  const {jobs}=await api('jobs?per_page=100');
  const selected=jobs.filter(j=>j.name.startsWith(`build (${os},`));
  assert.equal(selected.length,3,'exactly three source builds required');
  const state=selected.map(j=>`${j.id}:${j.status}:${j.conclusion}`).join(' ');
  if(state!==previous){console.log(state);previous=state;}
  const failed=selected.filter(j=>j.status==='completed'&&j.conclusion!=='success');
  assert.equal(failed.length,0,`hosted source build did not succeed: ${failed.map(j=>j.id).join(',')}`);
  if(selected.every(j=>j.status==='completed'&&j.conclusion==='success')){
   const {artifacts}=await api('artifacts?per_page=100');
   for(const arm of ['main','before','fix'])assert(artifacts.some(a=>a.name===`wide-binding-${os}-${arm}`&&!a.expired),'release artifact missing');
   console.log(`RELEASE_RECEIPTS_READY ${os}`);return;
  }
  await new Promise(resolve=>setTimeout(resolve,60000));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
