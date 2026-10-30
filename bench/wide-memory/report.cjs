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
 if(summary.complete){assert.equal(summary.sampleCount,60);assert.equal(summary.controls.length,8);assert.match(fs.readFileSync(path.join(folder,'identity-negative.log'),'utf8'),/WRONG_BINDING_HASH/);assert.match(fs.readFileSync(path.join(folder,'observer-negative.log'),'utf8'),/OBSERVER_IN_PROBE_GAP/);assert.match(fs.readFileSync(path.join(folder,'metadata-negative.log'),'utf8'),/INITIAL_METADATA_RETAINED_OBJECT/);}
 entries[os]={folder,summary};
}
const signed=(n,d=2)=>`${n>=0?'+':''}${n.toFixed(d)}`;
const flags=[];
let report='# PR #59 cross-platform memory and startup\n\n';
report+='Release sources are main `79c650c24e4b468e743ebfe6454b3b2bc6650938`, before `b87c553ce76f2055d2ee19de589f5bbc106ff23d`, and fix `90f41a8ac8200533cdc96aa31b4b818bf8a75561`. Watchpack is 2.6.3 through the main compiler with its native watcher disabled.\n\n';
report+='Build run [41106150672](https://github.com/guru-irl/rspack/actions/runs/41106150672) uses nine release builds with `plugin,info-level`. Measurement run is ['+process.env.GITHUB_RUN_ID+'](https://github.com/guru-irl/rspack/actions/runs/'+process.env.GITHUB_RUN_ID+'). All builds and samples use GitHub-hosted runners and Node 22.23.3.\n\n';
report+=`Bench branch \`bench/pr59-xplat-memory\` is at \`${process.env.GITHUB_SHA}\`.\n\n`;
report+='Each OS uses one measurement host, fresh processes, five alternating forward/reverse rounds per arm and scenario, and no forced GC. Tables show medians. Delta rows are medians of within-repetition paired deltas, followed by paired percentages. Ranges, phase RSS values, CPU and filesystem counters are retained in the raw receipts. Final lines refer to the wide 20k-folder context.\n\n';
report+='Readiness is watch start until all ten fixed-seed probe edits appear in rebuild `modifiedFiles`. After first done, each pending probe is rewritten every 200 ms. First probe is watch start until the first such delivery. Linux also samples inotify watches every 200 ms in a separate process and reports the final count confirmed stable for 2.4 seconds. The 200 ms probe cadence and 50 ms aggregate timeout are part of these times.\n\n';
report+='The wide and symlink contexts have 20,000 filler folders, two text files per folder, and ten selected probe modules per run. The symlink context also has 500 modules under both real and symlink spellings. The module-only case has 2,000 modules in 2,200 nested folders and probes ten existing module folders. Edits used for latency change a non-aliased module.\n\n';
report+='Startup peak is the process high-water through probe readiness. Full peak also includes registration, readiness probes and 20 edit rebuilds. The first-done phase has only a cached 10 ms RSS sample so it cannot delay the first probe. Idle RSS is the median of seconds 6-10 after probe readiness. Edited RSS is the median of five one-second samples after three seconds of quiet following the twentieth edit. All platforms use `process.resourceUsage().maxRSS` plus 10 ms RSS sampling. Windows cross-checks the final high-water against `PeakWorkingSet64` outside readiness and edit timing. Hashes are read in 64 KiB chunks before the RSS baseline.\n\n';
const sourceLines=fs.readFileSync('bench/wide-memory/sample.cjs','utf8').split('\n');
const callbackLine=sourceLines.findIndex(line=>line.startsWith('function onBuild('))+1;
const loopLine=sourceLines.findIndex(line=>line.includes('const rewrite=()=>'))+1;
const firstWriteLine=sourceLines.findIndex(line=>line.includes('rewrite();probeWriter='))+1;
const releaseLine=sourceLines.findIndex(line=>line.startsWith('function validateInitialAndRelease('))+1;
report+=`In counted processes the initial callback at \`bench/wide-memory/sample.cjs:${callbackLine}-${callbackLine+8}\` resolves first done without RSS, resource, CPU or bundle reads. The probe loop at \`bench/wide-memory/sample.cjs:${loopLine}-${firstWriteLine}\` writes before any such observer. macOS has no ps, vm_stat or fs_usage call in that gap. A runtime guard rejects any counter or external observer before the first probe write; every OS also runs its negative control. Initial Stats and VM output are scoped to \`bench/wide-memory/sample.cjs:${releaseLine}-${releaseLine+9}\`; only primitive metadata survives into idle and edit sampling, checked by a retained-Stats negative control.\n\n`;
for(const os of systems){
 const entry=entries[os];report+=`## ${os}\n\n`;
 if(entry.missing){report+='| State | Result |\n|---|---|\n| Measurements | not run; no complete artifact |\n\n';continue;}
 const {summary,folder}=entry;
 const keys=[['Readiness ms','readinessMs'],['First probe ms','firstProbeMs'],['First done ms','firstDoneMs'],...(os==='Linux'?[['Inotify stable ms','inotifyStableMs']]:[]),['Startup peak MiB','readinessPeakMiB'],['Full peak MiB','fullPeakMiB'],['Idle MiB','idleRssMiB'],['20-edit MiB','editedRssMiB'],['Edit ms','editLatencyMs'],['Native watches','watchesIdle.count']];
 if(summary.complete){
  const gap=summary.data.modules.firstDoneToProbeWriteMs;
  const maxGap=Math.max(...Object.values(summary.data).flatMap(d=>Object.values(d.firstDoneToProbeWriteMs.arms).map(a=>a.max)));
  report+=`First-done to first-write gap, 2k-module medians: main ${gap.arms.main.median.toFixed(3)} ms, before ${gap.arms.before.median.toFixed(3)} ms, fix ${gap.arms.fix.median.toFixed(3)} ms, Watchpack ${gap.arms.wp.median.toFixed(3)} ms. Largest gap across all 60 processes ${maxGap.toFixed(3)} ms.\n\n`;
 }
 report+=`| Scenario / arm | ${keys.map(([label])=>label).join(' | ')} |\n|---|${keys.map(()=>'---:').join('|')}|\n`;
 for(const scenario of scenarios){
  for(const arm of [...arms,'fix minus before','fix minus main']){
   const delta=arm.startsWith('fix minus '),base=delta?arm.slice(10):null;
   const cells=keys.map(([,key])=>{
    const metric=summary.data[scenario][key];
    if(arm==='wp'&&['editLatencyMs','watchesIdle.count'].includes(key))return 'not requested';
    if(delta){const p=metric.pairs[base];return !p?'not available':key==='watchesIdle.count'?signed(p.delta.median,0):`${signed(p.delta.median)} / ${signed(p.percent.median)}%`;}
    const s=metric.arms[arm];return s.median===null?(s.notExposed?'not exposed':`incomplete ${s.n}/5`):key==='watchesIdle.count'&&s.min!==s.max?`${s.median} [${s.min}, ${s.max}]`:s.median.toFixed(key==='watchesIdle.count'?0:2);
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
 const parts=systems.map(os=>{const d=entries[os].summary.data.wide;return `${os} ${signed(d.fullPeakMiB.pairs.before.delta.median)} MiB full-run peak RSS and ${signed(d.readinessMs.pairs.before.delta.median)} ms probe readiness`;});
 report+=`On a 20,000-folder context, the cross-platform fix changes cost versus b87c553c by ${parts.join(', ')}.\n\n`;
}else report+='No complete three-OS numeric sentence is available.\n\n';
report+='## Escalations\n\n';
const preferredFlags=flags.filter(f=>!f.metric||f.base==='before'||!flags.some(g=>g.os===f.os&&g.scenario===f.scenario&&g.metric===f.metric&&g.base==='before'));
const metricLabel={readinessMs:'probe readiness',readinessPeakMiB:'startup RSS',fullPeakMiB:'full-run peak RSS'};
if(flags.length)for(const os of systems){
 const group=preferredFlags.filter(f=>f.os===os);if(!group.length)continue;
 const facts=group.map(f=>f.metric?`${f.scenario} ${metricLabel[f.metric]||f.metric} ${signed(f.delta)} ${f.metric==='readinessMs'?'ms':'MiB'} / ${signed(f.percent)}% versus ${f.base}`:`${f.scenario||''} ${f.arm||''} ${f.kind}`);
 report+=`ESCALATION[warning]: ${os}: ${facts.join('; ')}.\n\n`;
}else report+='No measured threshold was exceeded.\n\n';
report+='Comparisons with before isolate this cross-platform fix. Linux costs versus main also include the earlier PR #59 changes.\n\n';
report+='## Superseded runs\n\n';
report+='Run 41115683971 is excluded. Its Windows positive control could not resolve the bare Watchpack development package; the version check now reads the prebundled package used by the compiler. Linux main also failed one symlink probe-output check, with an unexpected export and no recorded value. That failed command was not a sample and does not prove a missed edit. Its log is `wide-results-Linux/symlink-main-4.log`.\n\n';
report+='Run 41117477873 passed all 180 processes, but its timings are superseded. Windows queried PowerShell synchronously before writing probes. macOS had no external ps/vm_stat/fs_usage call, but the shared callback read RSS and resource counters and validated the initial bundle before the first probe write. The previously reported macOS +878 ms is not used here.\n\n';
report+='Run 41128483603 removed the observer gap, but retained the initial Stats object through the resolved promise. Stats holds a Compilation reference at `packages/rspack/src/Stats.ts:25-33`. That pass is also excluded. Retention control run 41133253138 reproduced the problem on all three OSes; the counted rerun deletes that reference and scopes VM validation to a short-lived function.\n\n';
report+='Guard regression run 41127477298 reproduced the pre-probe observer on all three OSes. The counted rerun resolves first done without observers, writes probes, then validates the initial bundle. The guard remains active throughout the first-done-to-first-write gap. All macOS jobs received runners on their first attempt; no no-runner retry was needed.\n\n';
report+='ESCALATION[warning]: The excluded first run contains an unclassified Linux main probe-output failure. The later counted samples do not erase it.\n\n';
report+='## Attention\n\n';
report+='Work and review stayed inline because the user forbade subagents. Build the Lever produced the fixture generator, probe driver and receipt auditor. Explain the Number kept first done separate from probe readiness and retained system counters and raw ranges. The branch starts at `1463464694cd8571a74d2f1223ce1bf54df87ea2`; the original Windows-only workflow was replaced with the prior three-OS release structure because name and source changes alone could not measure three OSes. No release build was cancelled.\n\n';
const lines=[];
for(const os of systems){
 const summary=entries[os].summary;
 if(!summary?.complete){lines.push(`${os} startup=not run peak=not run steady=not run watches=${os==='macOS'?'not exposed':'not run'}`);continue;}
 const d=summary.data.wide;
 const pair=(key,unit)=>['before','main'].map(base=>{const p=d[key].pairs[base];return p?`vs-${base} ${signed(p.delta.median)}${unit} (${signed(p.percent.median)}%)`:'not exposed';}).join(', ');
 const count=d['watchesIdle.count'],watches=count.arms.fix.median;
 lines.push(`${os} startup=${pair('readinessMs','ms')} peak=${pair('fullPeakMiB','MiB')} steady=idle ${pair('idleRssMiB','MiB')}; edited ${pair('editedRssMiB','MiB')} watches=${watches===null?'not exposed':`${watches} (vs-before ${signed(count.pairs.before.delta.median,0)}, vs-main ${signed(count.pairs.main.delta.median,0)})`}`);
}
const largeSummary=systems.flatMap(os=>{
 const group=preferredFlags.filter(f=>f.os===os);if(!group.length)return [];
 const worst=[...group].sort((a,b)=>(b.percent||0)-(a.percent||0))[0];
 return [`${os} ${worst.scenario||''} ${metricLabel[worst.metric]||worst.kind} ${worst.percent===undefined?'':signed(worst.percent)+'%'} versus ${worst.base||'delivery'}`];
});
lines.push(`LARGE=${flags.length?'yes, '+largeSummary.join('; '):systems.every(os=>entries[os].summary?.complete)?'no':'unknown, incomplete measurements'}`);
report+=lines.join('\n')+'\n';
fs.writeFileSync(path.join(out,'pr59-xplat-memory-report.md'),report);
fs.writeFileSync(path.join(out,'final-lines.txt'),lines.join('\n')+'\n');
fs.writeFileSync(path.join(out,'flags.json'),JSON.stringify(flags,null,2)+'\n');
console.log(report);
