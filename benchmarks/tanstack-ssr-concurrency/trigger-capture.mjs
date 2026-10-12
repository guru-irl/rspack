// Passive event observation. Never replace either watch callback or Watchpack methods.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
export function triggerCapture({step, now, normalize}) {
  const observations=[], writers=[], passes=[], states=new Map(), graph=new Map();
  const paths=items=>[...(items??[])].map(p=>normalize(String(p))).sort();
  const observe=(name,kind,extra={})=>{
    const record={step:step(),name,kind,t:now(),...extra};
    observations.push(record); return record;
  };
  const recordWrite=(file,operation)=>{
    if(typeof file!=='string' && !(file instanceof URL))return;
    const absolute=file instanceof URL?file.pathname:path.resolve(file);
    // Fixture source edits, resolver writes and route-tree generation only.
    if(!absolute.startsWith(path.join(process.cwd(),'src')+path.sep) && !absolute.startsWith(path.join(process.cwd(),'aux')+path.sep) && !absolute.includes('_tanstack-start-'))return;
    writers.push({t:now(),step:step(),file:normalize(absolute),operation,writerStack:new Error().stack});
  };
  function installWriters() {
    const operations=['writeFile','appendFile','truncate','unlink','rename','copyFile','createWriteStream'];
    for(const target of [fs,fs.promises])for(const operation of operations)for(const suffix of target===fs?['','Sync']:['']) {
      const key=operation+suffix,original=target[key];if(typeof original!=='function')continue;
      target[key]=function(...args) {
        recordWrite(args[0],key);
        if(['rename','copyFile'].includes(operation))recordWrite(args[1],key);
        return Reflect.apply(original,this,args);
      };
    }
    syncBuiltinESMExports();
  }
  function install(compiler,name) {
    const state={cursor:0,pass:0,latest:undefined,done:undefined}; states.set(name,state);
    const wfs=compiler.watchFileSystem;
    const watch=wfs.watch;
    wfs.watch=function(...args) {
      const callbacks=[args[5],args[6]];
      const result=Reflect.apply(watch,this,args);
      assert.equal(args[5],callbacks[0]);assert.equal(args[6],callbacks[1]);
      observe(name,'attach',{startTime:args[3],callbackIdentityPreserved:true});
      const raw=this.watcher;
      if(raw) {
        // DirectoryWatcher emits the type and Watchpack propagates it unchanged.
        raw.on('change',(file,time,type)=>observe(name,'change',{
          file:normalize(file),changeTime:time,type,
          branch:/outdated on attach/.test(type||'')?'outdated-on-attach':'normal-change',stack:new Error().stack
        }));
        raw.on('remove',(file,type)=>observe(name,'remove',{file:normalize(file),type,branch:'normal-change',stack:new Error().stack}));
        raw.on('aggregated',(changed,removed)=>observe(name,'aggregate',{modifiedFiles:paths(changed),removedFiles:paths(removed)}));
      }
      return result;
    };
    // Observe real virtual writes before delegating with the same receiver,
    // arguments and return value. Delivered dist files remain unmodified.
    for(const plugin of compiler.options.plugins) if(typeof plugin?.writeModule==='function') {
      const write=plugin.writeModule;
      plugin.writeModule=function(file,content) {
        recordWrite(String(file),'Start-virtual-write');
        observe(name,'virtual-write',{file:normalize(String(file)),writerStack:new Error().stack});
        return Reflect.apply(write,this,arguments);
      };
    }
    compiler.hooks.invalid.tap('PassTriggerObserver',(file,changeTime)=>observe(name,'invalid',{file:file&&normalize(file),changeTime,stack:new Error().stack}));
    compiler.hooks.watchRun.tap({name:'PassTriggerObserver',stage:-30000},()=>{
      const evidence=observations.slice(state.cursor).filter(e=>e.name===name);
      state.cursor=observations.length;
      const dependencies=[...new Set([...(compiler.options.dependencies||[]),...(graph.get(name)||[])])].map(parent=>({name:parent,pass:states.get(parent)?.done})).filter(p=>p.pass&&p.pass.started>(state.latest?.started??-Infinity));
      const changes=evidence.filter(e=>['change','remove'].includes(e.kind));
      const writes=evidence.filter(e=>e.kind==='virtual-write');
      const triggers=[];
      if(state.pass===0)triggers.push('initial');
      for(const e of changes)if(!triggers.includes(e.branch))triggers.push(e.branch);
      if(writes.length)triggers.push('Start-virtual-write');
      // Retain the exact completed upstream pass, not a count-based guess.
      if(dependencies.length)triggers.push('edge-propagation');
      const pass={step:step(),name,pass:++state.pass,started:now(),modifiedFiles:paths(compiler.modifiedFiles),removedFiles:paths(compiler.removedFiles),triggers:triggers.length?triggers:['unknown'],dependencies:dependencies.map(p=>({name:p.name,pass:p.pass.pass,started:p.pass.started,finished:p.pass.finished})),evidence};
      passes.push(pass);state.latest=pass;
    });
    compiler.hooks.done.tap({name:'PassTriggerObserver',stage:20000},()=>{
      state.latest.finished=now();state.done=state.latest;
    });
  }
  return {install,installWriters,setGraph:multi=>{for(const compiler of multi.compilers||[multi])graph.set(compiler.name,multi.dependencies?.get(compiler)||[]);},latest:name=>states.get(name)?.latest,evidence:()=>({callbackIdentityPreserved:true,observations,writers,passes})};
}
export function edgeContract(reference,edged,edge) {
  const ordering=data=>{
    for(const pass of data.passes.filter(p=>p.name==='ssr'))for(const upstream of data.passes.filter(p=>p.name==='client'||(edge==='transitive'&&p.name==='aux-a'))) {
      assert.ok(!(upstream.started<=pass.started&&pass.started<upstream.finished),`${edge}: SSR overlaps ${upstream.name} pass ${upstream.pass}`);
    }
    assert.ok(data.callbackIdentityPreserved,'watcher callback identity');
  };
  ordering(reference);ordering(edged);
  const replayReference=replaySummary(reference),replayEdge=replaySummary(edged);
  const differences=[];
  const keys=new Set([...reference.passes,...edged.passes].map(p=>JSON.stringify([p.step,p.name])));
  for(const key of keys) {
    const [step,name]=JSON.parse(key);
    const a=reference.passes.filter(p=>p.step===step&&p.name===name),b=edged.passes.filter(p=>p.step===step&&p.name===name);
    if(a.length===b.length)continue;
    const extra=(b.length>a.length?b:a).slice(Math.min(a.length,b.length));
    for(const pass of extra)assert.ok(!pass.triggers.includes('unknown'),`${edge} ${step} ${name}: extra pass ${pass.pass} has unknown trigger`);
    differences.push({step,name,reference:a.length,edge:b.length,extra,referenceNonReplay:a.filter(p=>!isReplay(reference,p)).length,edgeNonReplay:b.filter(p=>!isReplay(edged,p)).length});
  }
  // Output differences, including fewer passes with different output, fail
  // the unchanged checkpoint parity guard before this contract is evaluated.
  return {passed:true,edge,ordering:true,callbackIdentityPreserved:true,differences,replayReference,replayEdge,reference,edged};
}

// All passes remain in timing spans and total-pass metrics.
export const passClasses=['normal','write-driven attach','pure replay','Start-attributed','unknown'];
export const writerCategories=['scenario','toolchain','startup','none','unknown'];
export function writerCategory(write) {
  const stack=write.writerStack||'';
  const caller=stack.split('\n').find(line=>/\bat\b/.test(line) && !line.includes('/trigger-capture.mjs:'))||'';
  if(/@tanstack\/router-generator\//.test(caller) && /(?:^|\/)routeTree\.gen\.ts$/.test(write.file))return 'toolchain';
  if(/@tanstack\/start-plugin-core\//.test(caller) && /(?:virtual-modules|resolver)/.test(stack))return 'toolchain';
  if(/\/run\.mjs:\d+:\d+/.test(caller))return 'scenario';
  return 'unknown';
}
export function passAttribution(data,pass) {
  const label=`${pass.step} ${pass.name} pass ${pass.pass}`;
  assert.ok(!pass.triggers.includes('unknown'),`${label}: unknown trigger`);
  if(pass.triggers.includes('initial'))return {classification:'normal',writerCategory:'startup',writes:[]};
  const previous=data.passes.filter(p=>p.name===pass.name && p.started<pass.started).at(-1);
  const files=p=>[...new Set([...(p.modifiedFiles||[]),...(p.removedFiles||[])])].sort();
  const paths=files(pass);
  const writes=(data.writers||[]).filter(w=>w.t>(previous?.started??-Infinity) && w.t<=pass.started && paths.includes(w.file));
  if(writes.length) {
    assert.ok(paths.every(file=>writes.some(w=>w.file===file)),`${label}: unknown writer for modified/removed path`);
    const categories=writes.map(writerCategory);
    assert.ok(!categories.includes('unknown'),`${label}: unknown intervening writer`);
    if(pass.triggers.includes('outdated-on-attach')) {
      const attached=(pass.evidence||[]).filter(e=>e.branch==='outdated-on-attach').map(e=>e.file);
      assert.ok(paths.every(file=>attached.includes(file)),`${label}: replay lacks Watchpack branch evidence for each path`);
    }
    return {classification:pass.triggers.includes('normal-change')?'normal':pass.triggers.includes('outdated-on-attach')?'write-driven attach':'Start-attributed',writerCategory:categories.includes('scenario')?'scenario':'toolchain',writes};
  }
  if(pass.triggers.includes('outdated-on-attach')) {
    const replayFiles=[...new Set((pass.evidence||[]).filter(e=>e.branch==='outdated-on-attach').map(e=>e.file))].sort();
    assert.ok(replayFiles.length,`${label}: replay lacks Watchpack branch evidence for each path`);
    assert.ok(previous && paths.length,`${label}: replay has no preceding same paths`);
    assert.deepEqual(paths,files(previous),`${label}: replay must have same paths as preceding pass`);
    assert.ok(paths.every(file=>replayFiles.includes(file)),`${label}: replay lacks Watchpack branch evidence for each path`);
    return {classification:'pure replay',writerCategory:'none',writes:[]};
  }
  const virtual=(pass.evidence||[]).filter(e=>e.kind==='virtual-write');
  if(virtual.length) {
    assert.ok(virtual.every(e=>writerCategory(e)==='toolchain'),`${label}: unknown virtual writer`);
    return {classification:'Start-attributed',writerCategory:'toolchain',writes:virtual};
  }
  if(pass.triggers.includes('edge-propagation')) {
    const parents=(pass.dependencies||[]).map(d=>data.passes.find(p=>p.name===d.name && p.pass===d.pass));
    assert.ok(parents.length && parents.every(p=>p && p.started<pass.started),`${label}: unknown edge writer`);
    const causes=parents.map(p=>passAttribution(data,p));
    const category=causes.some(c=>c.writerCategory==='scenario')?'scenario':causes.some(c=>c.writerCategory==='toolchain')?'toolchain':causes.every(c=>c.writerCategory==='startup')?'startup':'none';
    return {classification:'normal',writerCategory:category,dependencies:pass.dependencies,writes:causes.flatMap(c=>c.writes)};
  }
  assert.fail(`${label}: unknown writer or trigger class`);
}
export function classifyPass(data,pass) {return passAttribution(data,pass).classification;}
export function isReplay(data,pass) {return classifyPass(data,pass)==='pure replay';}
export function replaySummary(data) {
  assert.ok(data.callbackIdentityPreserved,'watcher callback identity');
  const checkpoints=[];
  for(const pass of data.passes) {
    const attribution=passAttribution(data,pass),replay=attribution.classification==='pure replay';
    let record=checkpoints.find(c=>c.step===pass.step && c.name===pass.name);
    if(!record){record={step:pass.step,name:pass.name,passes:0,nonReplay:0,scenarioPasses:0,replays:0,replayPasses:[],classes:Object.fromEntries(passClasses.map(c=>[c,0])),writerCategories:Object.fromEntries(writerCategories.map(c=>[c,0])),classifiedPasses:[]};checkpoints.push(record);}
    record.passes++;record.classes[attribution.classification]++;record.writerCategories[attribution.writerCategory]++;
    record.classifiedPasses.push({pass:pass.pass,...attribution});
    if(attribution.writerCategory==='scenario')record.scenarioPasses++;
    assert.ok(record.writerCategories.toolchain<=2,`${pass.step} ${pass.name}: toolchain pass bound exceeded`);
    if(replay){record.replays++;record.replayPasses.push(pass.pass);}else record.nonReplay++;
  }
  return {passed:true,conditions:['scenario writes count against exact/bounded expectations','attach paths match captured writes in start-to-start interval','pure replay matches preceding paths with no write','toolchain writer stack required, <=2 passes/compiler/checkpoint','unknown is a stop'],checkpoints};
}
export function assertPassCount(data,step,name,expected,label) {
  const summary=replaySummary(data);
  const count=summary.checkpoints.find(c=>c.step===step && c.name===name)?.scenarioPasses||0;
  assert.equal(count,expected,`${label}: scenario-triggered pass count`);
  return summary;
}
export function assertPassBounds(data,step,name,saves,label) {
  const summary=replaySummary(data);
  const count=summary.checkpoints.find(c=>c.step===step && c.name===name)?.scenarioPasses||0;
  assert.ok(count>=1 && count<=saves,`${label}: scenario-triggered pass count ${count}, saves ${saves}`);
  return summary;
}
