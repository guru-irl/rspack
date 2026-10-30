'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]||'.bench-wide/collected'),out=path.resolve('.bench-wide/report');
fs.mkdirSync(out,{recursive:true});
const systems=['Linux','macOS','Windows'],scenarios=['wide','modules','symlink'],arms=['main','before','fix','wp'];
const entries={};
for(const os of systems){
 const folder=path.join(root,`wide-results-${os}`),file=path.join(folder,'summary.json');
 if(!fs.existsSync(file)){entries[os]={folder,missing:true};continue;}
 const summary=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(summary.platform,os);
 if(summary.complete){assert.equal(summary.sampleCount,60);assert.equal(summary.controls.length,8);assert.match(fs.readFileSync(path.join(folder,'identity-negative.log'),'utf8'),/WRONG_BINDING_HASH/);}
 entries[os]={folder,summary};
}
const signed=(n,d=2)=>`${n>=0?'+':''}${n.toFixed(d)}`;
const flags=[];
let report='# PR #59 cross-platform memory and startup\n\n';
report+='Release sources are main `79c650c24e4b468e743ebfe6454b3b2bc6650938`, before `b87c553ce76f2055d2ee19de589f5bbc106ff23d`, and fix `90f41a8ac8200533cdc96aa31b4b818bf8a75561`. Watchpack is 2.6.3 through the main compiler with its native watcher disabled.\n\n';
report+='Build run [41106150672](https://github.com/guru-irl/rspack/actions/runs/41106150672) uses nine release builds with `plugin,info-level`. Measurement run is ['+process.env.GITHUB_RUN_ID+'](https://github.com/guru-irl/rspack/actions/runs/'+process.env.GITHUB_RUN_ID+'). All builds and samples use GitHub-hosted runners and Node 22.23.3.\n\n';
report+='Each OS uses one measurement host, fresh processes, five alternating forward/reverse rounds per arm and scenario, and no forced GC. Tables show medians. Delta rows are medians of within-repetition paired deltas, followed by paired percentages. Ranges, phase RSS values, CPU and filesystem counters are retained in the raw receipts. Final lines refer to the wide 20k-folder context.\n\n';
report+='Readiness is watch start until all ten fixed-seed probe edits appear in rebuild `modifiedFiles`. After first done, each pending probe is rewritten every 200 ms. First probe is watch start until the first such delivery. Linux also samples inotify watches every 200 ms in a separate process and reports the final count confirmed stable for 2.4 seconds. The 200 ms probe cadence and 50 ms aggregate timeout are part of these times.\n\n';
report+='The wide and symlink contexts have 20,000 filler folders, two text files per folder, and ten selected probe modules per run. The symlink context also has 500 modules under both real and symlink spellings. The module-only case has 2,000 modules in 2,200 nested folders and probes ten existing module folders. Edits used for latency change a non-aliased module.\n\n';
report+='Peak is the process high-water through the full run, including registration, readiness probes and 20 edit rebuilds. First-done and readiness phase peaks remain in the raw receipts. Idle RSS is the median of seconds 6-10 after probe readiness. Edited RSS is the median of five one-second samples after three seconds of quiet following the twentieth edit. Windows uses `PeakWorkingSet64`; Linux and macOS use `process.resourceUsage().maxRSS`, combined with 10 ms RSS sampling. Hashes are read in 64 KiB chunks before the RSS baseline.\n\n';
for(const os of systems){
 const entry=entries[os];report+=`## ${os}\n\n`;
 if(entry.missing){report+='| State | Result |\n|---|---|\n| Measurements | not run; no complete artifact |\n\n';continue;}
 const {summary,folder}=entry;
 const keys=[['Readiness ms','readinessMs'],['First probe ms','firstProbeMs'],['First done ms','firstDoneMs'],...(os==='Linux'?[['Inotify stable ms','inotifyStableMs']]:[]),['Peak MiB','fullPeakMiB'],['Idle MiB','idleRssMiB'],['20-edit MiB','editedRssMiB'],['Edit ms','editLatencyMs'],['Native watches','watchesIdle.count']];
 report+=`| Scenario / arm | ${keys.map(([label])=>label).join(' | ')} |\n|---|${keys.map(()=>'---:').join('|')}|\n`;
 for(const scenario of scenarios){
  for(const arm of [...arms,'fix minus before','fix minus main']){
   const delta=arm.startsWith('fix minus '),base=delta?arm.slice(10):null;
   const cells=keys.map(([,key])=>{
    const metric=summary.data[scenario][key];
    if(arm==='wp'&&['editLatencyMs','watchesIdle.count'].includes(key))return 'not requested';
    if(delta){const p=metric.pairs[base];return !p?'not available':`${signed(p.delta.median,key==='watchesIdle.count'?0:2)} / ${signed(p.percent.median)}%`;}
    const s=metric.arms[arm];return s.median===null?(s.notExposed?'not exposed':`incomplete ${s.n}/5`):s.median.toFixed(key==='watchesIdle.count'?0:2);
   });
   report+=`| ${scenario} / ${arm} | ${cells.join(' | ')} |\n`;
  }
 }
 report+='\n';
 report+=`Samples ${summary.sampleCount}/60, checked bundle outputs ${summary.outputChecks}, receipt controls ${summary.controls.length}/8.\n\n`;
 for(const arm of ['main','before','fix']){
  const pin=summary.identities[arm],sampleFile=path.join(folder,`wide-${arm}-1.json`);
  const selected=fs.existsSync(sampleFile)?JSON.parse(fs.readFileSync(sampleFile,'utf8')).identity.selected:'not available';
  report+=`- ${arm}: \`${selected}\`, SHA-256 \`${pin.sha256}\`.\n`;
 }
 report+='\n';
 if(summary.large.length){for(const flag of summary.large)flags.push({os,...flag});}
 const failuresFile=path.join(folder,'failures.json');
 if(fs.existsSync(failuresFile))for(const failure of JSON.parse(fs.readFileSync(failuresFile,'utf8'))){
  const logFile=failure.arm?path.join(folder,`${failure.scenario}-${failure.arm}-${failure.rep}.log`):null;
  const text=logFile&&fs.existsSync(logFile)?fs.readFileSync(logFile,'utf8'):'';
  flags.push({os,kind:/ARM_EDIT_FAILURE/.test(text)?'edit delivery failure':'failed command, excluded from samples',...failure});
 }
}
report+='## Checks and interpretation\n\n';
report+='Every counted process sets `NAPI_RS_NATIVE_LIBRARY_PATH`, records its absolute path and SHA-256, and proves the loaded native object through `/proc/self/maps` on Linux or `process.report.sharedObjects` on macOS and Windows. Each OS runs a real wrong-binding process control. The auditor rejects missing samples, wrong bindings, stale edited output, missing edits, duplicate samples, wrong source identities, missing readiness probes and stale probe output. Every initial, probe and measured edit rebuild checks the emitted bundle.\n\n';
report+='Linux watch counts come from inotify entries in `/proc/<pid>/fdinfo`. Windows counts open directory handles under the fixture through a separate PowerShell observer; positive and closed-handle controls check its counter. A macOS FSEvents stream count is not exposed by the APIs used here. Process RSS excludes kernel watch memory and the observer processes. The measurements compare whole watch sessions, not an isolated allocation count for the directory analyzer.\n\n';
report+='## Suggested PR cost sentence\n\n';
if(systems.every(os=>entries[os].summary?.complete)){
 const parts=systems.map(os=>{const d=entries[os].summary.data.wide;return `${os} ${signed(d.fullPeakMiB.pairs.before.delta.median)} MiB peak RSS and ${signed(d.readinessMs.pairs.before.delta.median)} ms probe readiness`;});
 report+=`On a 20,000-folder context, the cross-platform fix changes cost versus b87c553c by ${parts.join(', ')}.\n\n`;
}else report+='No complete three-OS numeric sentence is available.\n\n';
report+='## Escalations\n\n';
if(flags.length)for(const flag of flags){
 if(flag.metric)report+=`ESCALATION[warning]: ${flag.os} ${flag.scenario} ${flag.metric} is ${signed(flag.percent)}% versus ${flag.base}, paired delta ${signed(flag.delta)}.\n\n`;
 else report+=`ESCALATION[warning]: ${flag.os} ${flag.scenario||''} ${flag.arm||''} ${flag.kind}. See the failed process log; it is not a sample.\n\n`;
}else report+='No measured threshold was exceeded.\n\n';
report+='## Attention\n\n';
report+='Work and review stayed inline because the user forbade subagents. Build the Lever produced the fixture generator, probe driver and receipt auditor. Explain the Number kept first done separate from probe readiness and retained system counters and raw ranges. The branch starts at `1463464694cd8571a74d2f1223ce1bf54df87ea2`; the original Windows-only workflow was replaced with the prior three-OS release structure because name and source changes alone could not measure three OSes. No release build was cancelled.\n\n';
const lines=[];
for(const os of systems){
 const summary=entries[os].summary;
 if(!summary?.complete){lines.push(`${os} startup=not run peak=not run steady=not run watches=${os==='macOS'?'not exposed':'not run'}`);continue;}
 const d=summary.data.wide;
 const pair=key=>['before','main'].map(base=>{const p=d[key].pairs[base];return p?`${signed(p.delta.median)} ${signed(p.percent.median)}%`:'not exposed';}).join(', ');
 const watches=d['watchesIdle.count'].arms.fix.median;
 lines.push(`${os} startup=${pair('readinessMs')} peak=${pair('fullPeakMiB')} steady=idle ${pair('idleRssMiB')}; edited ${pair('editedRssMiB')} watches=${watches===null?'not exposed':`${watches}; deltas ${pair('watchesIdle.count')}`}`);
}
lines.push(`LARGE=${flags.length?'yes, '+flags.map(f=>`${f.os}/${f.scenario||'unknown'}/${f.metric||f.kind}/vs-${f.base||'delivery'}`).join('; '):systems.every(os=>entries[os].summary?.complete)?'no':'unknown, incomplete measurements'}`);
report+=lines.join('\n')+'\n';
fs.writeFileSync(path.join(out,'pr59-xplat-memory-report.md'),report);
fs.writeFileSync(path.join(out,'final-lines.txt'),lines.join('\n')+'\n');
fs.writeFileSync(path.join(out,'flags.json'),JSON.stringify(flags,null,2)+'\n');
console.log(report);
