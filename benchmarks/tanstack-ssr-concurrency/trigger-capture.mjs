// Passive event observation. Never replace either watch callback or Watchpack methods.
import assert from 'node:assert/strict';
export function triggerCapture({step, now, normalize}) {
  const observations=[], passes=[], states=new Map(), graph=new Map();
  const paths=items=>[...(items??[])].map(p=>normalize(String(p))).sort();
  const observe=(name,kind,extra={})=>{
    const record={step:step(),name,kind,t:now(),...extra};
    observations.push(record); return record;
  };
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
  return {install,setGraph:multi=>{for(const compiler of multi.compilers||[multi])graph.set(compiler.name,multi.dependencies?.get(compiler)||[]);},latest:name=>states.get(name)?.latest,evidence:()=>({callbackIdentityPreserved:true,observations,passes})};
}
export function edgeContract(reference,edged,edge) {
  const ordering=data=>{
    for(const pass of data.passes.filter(p=>p.name==='ssr'))for(const upstream of data.passes.filter(p=>p.name==='client'||(edge==='transitive'&&p.name==='aux-a'))) {
      assert.ok(!(upstream.started<=pass.started&&pass.started<upstream.finished),`${edge}: SSR overlaps ${upstream.name} pass ${upstream.pass}`);
    }
    assert.ok(data.callbackIdentityPreserved,'watcher callback identity');
  };
  ordering(reference);ordering(edged);
  const differences=[];
  const keys=new Set([...reference.passes,...edged.passes].map(p=>JSON.stringify([p.step,p.name])));
  for(const key of keys) {
    const [step,name]=JSON.parse(key);
    const a=reference.passes.filter(p=>p.step===step&&p.name===name),b=edged.passes.filter(p=>p.step===step&&p.name===name);
    if(a.length===b.length)continue;
    const extra=(b.length>a.length?b:a).slice(Math.min(a.length,b.length));
    for(const pass of extra)assert.ok(!pass.triggers.includes('unknown'),`${edge} ${step} ${name}: extra pass ${pass.pass} has unknown trigger`);
    differences.push({step,name,reference:a.length,edge:b.length,extra});
  }
  // Output differences, including fewer passes with different output, fail
  // the unchanged checkpoint parity guard before this contract is evaluated.
  return {passed:true,edge,ordering:true,callbackIdentityPreserved:true,differences,reference,edged};
}
