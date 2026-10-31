'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve('.bench-wide'),results=path.join(root,'results');
const platform={darwin:'macOS',win32:'Windows'}[process.platform];assert(platform);
const scenario=platform==='macOS'?'symlink':'modules';
fs.writeFileSync(path.join(results,'retry-receipt.json'),JSON.stringify({expectedReps:{wide:5,modules:10,symlink:10},missingWatchpack:[]}));
const sample=require(path.resolve('bench/cost-timeline/sample.cjs'))(fs.readFileSync('bench/wide-memory/sample.cjs','utf8'));
const script=path.resolve('bench/wide-memory/timeline-sample.cjs');fs.writeFileSync(script,sample);
const originalAudit=fs.readFileSync('bench/wide-memory/audit.cjs','utf8'),auditEnd=originalAudit.indexOf('const rows=fs.readdirSync(results)');assert(auditEnd>0);
fs.writeFileSync('bench/wide-memory/timeline-audit.cjs',originalAudit.slice(0,auditEnd)+'\nmodule.exports={validate,expectedHash};\n');
const {validate,expectedHash}=require(path.resolve('bench/wide-memory/timeline-audit.cjs'));
const run=(args,log,env={})=>{const fd=fs.openSync(path.join(results,log),'wx');try{return spawnSync(process.execPath,args,{env:{...process.env,...env},stdio:['ignore',fd,fd],timeout:660000});}finally{fs.closeSync(fd);}};
const controls=[];
let control=run([script,'cost',scenario,'1','identity-only'],'identity-positive.log');assert.equal(control.status,0);
control=run([script,'cost',scenario,'1','identity-only'],'identity-negative.log',{BENCH_EXPECTED_SHA256:'0'.repeat(64)});assert.notEqual(control.status,0);assert.match(fs.readFileSync(path.join(results,'identity-negative.log'),'utf8'),/WRONG_BINDING_HASH/);controls.push('wrong-binding-process');
for(const [mode,log,marker]of[['observer-negative','observer-negative.log','OBSERVER_IN_PROBE_GAP'],['retained-stats-negative','metadata-negative.log','INITIAL_METADATA_RETAINED_OBJECT']]){control=run([script,'main','modules','1',mode],log);assert.notEqual(control.status,0);assert(fs.readFileSync(path.join(results,log),'utf8').includes(marker));controls.push(mode);}
control=run([script,'main','modules','1','diagnostic-control'],'diagnostic-control.log');assert.notEqual(control.status,0);
const diagnosticText=fs.readFileSync(path.join(results,'diagnostic-control.log'),'utf8');assert.match(diagnosticText,/DIAGNOSTIC_CONTROL_DONE/);
const diagnostic=JSON.parse(diagnosticText.split('\n').find(l=>l.startsWith('PROBE_EXPORT_DIAGNOSTIC ')).slice('PROBE_EXPORT_DIAGNOSTIC '.length));
assert.equal(diagnostic.actualBundleValue,String(diagnostic.expectedInitialValue));assert(diagnostic.diskContent.includes(`module.exports = ${diagnostic.expectedProbeValue};`));assert(Number.isFinite(diagnostic.lastWriteEpochMs)&&Number.isFinite(diagnostic.rebuildStartEpochMs));controls.push('probe-diagnostic-process');
const rows=[],schedule=[],failures=[];
for(let rep=1;rep<=10;rep++)for(const [position,arm]of(rep%2?['before','cost']:['cost','before']).entries()){
 assert(Date.now()<Date.parse('2026-10-31T07:30:00Z'),'timeline queue launch deadline');
 const stem=`${scenario}-${arm}-${rep}`,log=`${stem}.log`,entry={arm,scenario,rep,position,started:new Date().toISOString()};
 console.log(JSON.stringify({kind:'start-timeline',...entry}));
 const outcome=run([script,arm,scenario,String(rep)],log);Object.assign(entry,{ended:new Date().toISOString(),exitCode:outcome.status,signal:outcome.signal,error:outcome.error?String(outcome.error):null});schedule.push(entry);
 fs.writeFileSync(path.join(results,'schedule.json'),JSON.stringify(schedule,null,2));
 const text=fs.readFileSync(path.join(results,log),'utf8');
 if(outcome.status!==0){
  const fixture=JSON.parse(fs.readFileSync(path.join(root,'fixtures',scenario,'fixture.json'),'utf8')),match=text.match(/(?:stale output at version|version) (\d+)/);
  const failure={...entry,seed:fixture.probeSets[rep-1].seed,editNumber:match?Number(match[1]):null,read:null,log};
  const line=text.split('\n').find(l=>l.startsWith('PROBE_EXPORT_DIAGNOSTIC '));
  if(line)Object.assign(failure,{probeDiagnostic:JSON.parse(line.slice('PROBE_EXPORT_DIAGNOSTIC '.length)),read:JSON.parse(line.slice('PROBE_EXPORT_DIAGNOSTIC '.length)).actualBundleValue});
  else try{const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'output',stem,'bundle.js'),'utf8'),{module},{timeout:20000});failure.read=module.exports.value;}catch(error){failure.readError=String(error);}
  failures.push(failure);fs.writeFileSync(path.join(results,'failures.json'),JSON.stringify(failures,null,2));throw new Error(`Native timeline process failed: ${stem}`);
 }
 const row=JSON.parse(fs.readFileSync(path.join(results,`${stem}.json`),'utf8'));
 const native=text.split('\n').filter(l=>l.startsWith('WATCH_TIMELINE '));assert.equal(native.length,1,'one initial scan marker');
 row.timeline={...JSON.parse(native[0].slice('WATCH_TIMELINE '.length)),position};
 const epoch=row.timelineEpochMs;assert(Number.isFinite(epoch));
 for(const field of ['watchStartUs','updateEndUs','mtimeEndUs','analyzerEndUs','installEndUs','scanEndUs'])row.timeline[field.replace('Us','Ms')]=row.timeline[field]/1000-epoch;
 const first=row.probeRebuilds.find(r=>r.changed.length>0),last=row.probeRebuilds.at(-1);assert(first&&last);
 Object.assign(row.timeline,{firstDoneMs:row.firstDoneMs,firstProbeEventMs:row.firstProbeEventMs,probeBuildStartMs:first.startMs,probeBuildEndMs:last.elapsedMs,readyMs:row.readinessMs,probeRebuildCount:row.probeRebuilds.length,builds:row.builds});
 const t=row.timeline;
 Object.assign(t,{firstDoneToScanMs:t.scanEndMs-t.firstDoneMs,nativeQueueMs:t.watchStartMs-t.firstDoneMs,updateMs:(t.updateEndUs-t.watchStartUs)/1000,mtimeMs:(t.mtimeEndUs-t.updateEndUs)/1000,analyzerMs:(t.analyzerEndUs-t.mtimeEndUs)/1000,installMs:(t.installEndUs-t.analyzerEndUs)/1000,contextScanMs:(t.scanEndUs-t.installEndUs)/1000,scanToEventMs:t.firstProbeEventMs-t.scanEndMs,eventToBuildMs:t.probeBuildStartMs-t.firstProbeEventMs,probeBuildMs:t.probeBuildEndMs-t.probeBuildStartMs,endToReadyMs:t.readyMs-t.probeBuildEndMs,canonicalMs:t.canonicalNs/1000000,metadataMs:t.metadataNs/1000000,existingOwnLinkMs:t.existingOwnLinkNs/1000000,missingOwnLinkMs:t.missingOwnLinkNs/1000000,ancestorLinkMs:t.ancestorLinkNs/1000000});
 fs.writeFileSync(path.join(results,`${stem}.json`),JSON.stringify(row,null,2)+'\n');rows.push(row);
 console.log(JSON.stringify({kind:'end-timeline',arm,rep,timeline:t}));
}
function validateTimeline(input){
 assert.equal(input.length,20,'all twenty native processes required');validate(input,false);
 const seen=new Set();for(const row of input){assert.equal(row.scenario,scenario);assert(['before','cost'].includes(row.arm));const key=`${row.arm}/${row.rep}`;assert(!seen.has(key));seen.add(key);
  const t=row.timeline;for(const key of ['firstDoneMs','scanEndMs','firstProbeEventMs','probeBuildStartMs','probeBuildEndMs','readyMs'])assert(Number.isFinite(t[key]),key);
  assert(t.watchStartMs<=t.updateEndMs&&t.updateEndMs<=t.mtimeEndMs&&t.mtimeEndMs<=t.analyzerEndMs&&t.analyzerEndMs<=t.installEndMs&&t.installEndMs<=t.scanEndMs,'native phase order');
  assert(t.scanEndMs<=t.firstProbeEventMs+2&&t.firstProbeEventMs<=t.probeBuildStartMs+2&&t.probeBuildStartMs<=t.probeBuildEndMs&&t.probeBuildEndMs<=t.readyMs,'delivered phase order');
  assert.equal(t.readyMs,row.readinessMs);assert.equal(t.position,(row.rep%2?['before','cost']:['cost','before']).indexOf(row.arm));
 }
 for(let rep=1;rep<=10;rep++)for(const arm of ['before','cost'])assert(seen.has(`${arm}/${rep}`));
}
validateTimeline(rows);
for(const [name,mutate]of[
 ['missing-sample',copy=>copy.pop()],['wrong-binding',copy=>copy[0].identity.sha256='0'.repeat(64)],['stale-edited-output',copy=>copy[0].edits[0].actualHash=expectedHash(copy[0].scenario,copy[0].rep,0)],['missing-edit',copy=>copy[0].edits.pop()],['duplicate-sample',copy=>copy[0]=copy[1]],['wrong-source',copy=>copy[0].identity.source='x'],['missing-readiness-probe',copy=>copy[0].probes.pop()],['stale-probe-output',copy=>copy[0].probeRebuilds.at(-1).actualHash=expectedHash(copy[0].scenario,copy[0].rep,0,[])],['clock-order',copy=>copy[0].timeline.scanEndMs=-1],['missing-probe-event',copy=>delete copy[0].timeline.firstProbeEventMs]]){const copy=structuredClone(rows);mutate(copy);assert.throws(()=>validateTimeline(copy),undefined,`${name} accepted`);controls.push(name);}
fs.writeFileSync(path.join(results,'failures.json'),JSON.stringify(failures));
require(path.resolve('bench/cost-timeline/report.cjs'))({platform,scenario,rows,schedule,controls,failures,results});
