'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve('.bench-wide'),results=path.join(root,'results'),all=[];
let source=fs.readFileSync('bench/wide-memory/sample.cjs','utf8');
const marker='start=performance.now();cpuStart=process.cpuUsage();';
assert.equal(source.split(marker).length,2);
source=source.replace(marker,`if(typeof compiler.watchFileSystem.on==='function')for(const kind of ['change','remove'])compiler.watchFileSystem.on(kind,file=>{if(byPath.has(canonical(file)))console.log('BENCH_PROBE_EVENT '+JSON.stringify({kind,file,elapsedMs:performance.now()-start,epochMs:Date.now()}));});
 compiler.hooks.invalid.tap('BenchProbeInvalid',file=>{if(file&&byPath.has(canonical(file)))console.log('BENCH_PROBE_INVALID '+JSON.stringify({file,elapsedMs:performance.now()-start,epochMs:Date.now()}));});
 ${marker}`);
fs.writeFileSync('bench/wide-memory/sample.cjs',source);
fs.mkdirSync(path.join(results,'cpu'),{recursive:true});fs.mkdirSync(path.join(results,'syscalls'),{recursive:true});
const waitExit=child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
async function run(arm,rep){
 assert(Date.now()<Date.parse('2026-10-31T06:00:00Z'));
 const stem=`symlink-${arm}-${rep}`,log=path.join(results,`${stem}.log`),fd=fs.openSync(log,'wx');
 const child=spawn(process.execPath,['--cpu-prof','--cpu-prof-dir',path.join(results,'cpu'),'--cpu-prof-name',`${stem}.cpuprofile`,'bench/wide-memory/sample.cjs',arm,'symlink',String(rep)],{stdio:['ignore',fd,fd],env:process.env});
 const done=waitExit(child);
 process.kill(child.pid,'SIGSTOP');
 const trace=path.join(results,'syscalls',`${stem}.log`),traceFd=fs.openSync(trace,'wx');
 const native=process.env.BENCH_NATIVE_STACKS==='1',nativeFile=path.join(results,'syscalls',`${stem}.sample.txt`);
 const observer=native?spawn('/usr/bin/sample',[String(child.pid),'12','-file',nativeFile],{stdio:['ignore',traceFd,traceFd]}):spawn('sudo',['-n','/usr/bin/fs_usage','-w','-f','filesys','-t','15',String(child.pid)],{stdio:['ignore',traceFd,traceFd]});
 const observed=waitExit(observer);
 await new Promise(resolve=>setTimeout(resolve,500));process.kill(child.pid,'SIGCONT');
 const outcome=await done;fs.closeSync(fd);const observerOutcome=await observed;fs.closeSync(traceFd);
 const row=JSON.parse(fs.readFileSync(path.join(results,`${stem}.json`),'utf8'));
 const text=fs.readFileSync(log,'utf8'),events=text.split('\n').filter(l=>l.startsWith('BENCH_PROBE_EVENT ')).map(l=>JSON.parse(l.slice('BENCH_PROBE_EVENT '.length)));
 const invalid=text.split('\n').filter(l=>l.startsWith('BENCH_PROBE_INVALID ')).map(l=>JSON.parse(l.slice('BENCH_PROBE_INVALID '.length)));
 const syscallText=fs.readFileSync(trace,'utf8'),operations={},fixtureOperations={};let lost=0;
 for(const line of syscallText.split('\n')){
  if(/lost|dropped/i.test(line))lost++;
  const match=line.match(/^\s*[\d:.]+\s+(\S+)/);if(!match)continue;
  const op=match[1];operations[op]=(operations[op]||0)+1;
  if(line.includes('/fixtures/symlink/'))fixtureOperations[op]=(fixtureOperations[op]||0)+1;
 }
 const cpu=JSON.parse(fs.readFileSync(path.join(results,'cpu',`${stem}.cpuprofile`),'utf8')),byId=new Map(cpu.nodes.map(n=>[n.id,n])),times=new Map();
 for(let i=0;i<cpu.samples.length;i++)times.set(cpu.samples[i],(times.get(cpu.samples[i])||0)+(cpu.timeDeltas[i]||0)/1000);
 const cpuSelf=[...times].map(([id,ms])=>({ms,name:byId.get(id).callFrame.functionName,url:byId.get(id).callFrame.url,line:byId.get(id).callFrame.lineNumber})).sort((a,b)=>b.ms-a.ms).slice(0,40);
 const nativeInteresting=fs.existsSync(nativeFile)?fs.readFileSync(nativeFile,'utf8').split('\n').filter(l=>/rspack_watcher|rspack_core|rspack_plugin_context|rspack_paths|opendir|realpath|stat64|lstat64/.test(l)).slice(0,150):[];
 const watchDiagnostics=text.split('\n').filter(l=>/^WATCH_(DIAG|PHASE|CONTEXT|EXTRA) /.test(l)).map(line=>{const parts=line.split(' '),kind=parts.shift(),name=parts[0]?.includes('=')?null:parts.shift();return {kind,name,...Object.fromEntries(parts.filter(p=>p.includes('=')).map(p=>{const i=p.indexOf('='),v=p.slice(i+1);return[p.slice(0,i),/^\\d+$/.test(v)?Number(v):v];}))};});
 const result={arm,rep,outcome,observerOutcome,nativeInteresting,watchDiagnostics,firstEventMs:events[0]?.elapsedMs??null,firstInvalidMs:invalid[0]?.elapsedMs??null,eventCount:events.length,invalidCount:invalid.length,events,invalid,readinessMs:row.readinessMs,builds:row.builds,probeRebuilds:row.probeRebuilds,rewrites:row.probes.map(p=>({file:p.file,rewrites:p.rewrites})),operations,fixtureOperations,lost,cpuSelf};
 all.push(result);fs.writeFileSync(path.join(results,'profile-summary.json'),JSON.stringify(all,null,2)+'\n');
 assert.equal(outcome.code,0,'profiled command failed');if(!native){assert.equal(observerOutcome.code,0,'filesystem observer failed');assert(Object.keys(operations).length,'empty filesystem trace');}
}
(async()=>{for(let rep=1;rep<=3;rep++)for(const arm of(rep%2?['before','cost']:['cost','before']))await run(arm,rep);console.log(JSON.stringify(all,null,2));})().catch(error=>{console.error(error);process.exitCode=1;});
