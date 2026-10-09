import json,statistics,os
from pathlib import Path
root=Path(os.environ.get('BUILDINFO_BENCH_DIR','.bench/buildinfo-access')).resolve()
data=json.loads((root/'raw-summary.json').read_text())
rows=[d for d in data if not d['seed']]
med=statistics.median
units={'tapMs':1,'finishMakeAfterCompileMs':1,'compilerWallMs':1,'cpuMs':1,'peakMiB':1,'endMiB':1}
groups={}
for v in ['release','canary']:
 for s in ['cold','new','legacy','watch']:
  for a in ['iterate','read']:
   vals=[d for d in rows if (d['version'],d['scenario'],d['access'])==(v,s,a)]
   assert len(vals)==5,(v,s,a,len(vals))
   rs=[d['results'][-1] for d in vals]
   for r in rs:
    r['cpuMs']=r['cpuUserMs']+r['cpuSysMs']
    r['peakMiB']=r['peakRssAnonKiB']/1024
    r['endMiB']=r['endRssAnonKiB']/1024
   groups[v,s,a]={k:med(r[k] for r in rs) for k in units}
   groups[v,s,a]['tapMinMs']=min(r['tapMs'] for r in rs)
   groups[v,s,a]['tapMaxMs']=max(r['tapMs'] for r in rs)
   groups[v,s,a]['wallProcessMs']=med(d['processWallMs'] for d in vals)
   groups[v,s,a]['peakProcessMiB']=med(d['processPeakRssAnonKiB']/1024 for d in vals)
lines=['# BuildInfo first-access measurement','','## Measured matrix','','Medians of five interleaved samples. Tap, finishMake to afterCompile, compiler wall and user+system CPU are milliseconds. Memory is RssAnon in MiB, sampled every 20 ms, with exact done-hook end samples. One watch rebuild is measured after the initial watch compilation. No module iteration happens in the harness before the timed compiler.hooks.finishMake tap.','','| Binary | Condition | Tap | Tap ms | finishMake → afterCompile ms | Build wall ms | User+sys CPU ms | Peak MiB | End MiB |','|---|---|---|---:|---:|---:|---:|---:|---:|']
for s in ['cold','new','legacy','watch']:
 for a in ['iterate','read']:
  for v in ['release','canary']:
   r=groups[v,s,a]
   lines.append(f'| {v} | {s} | {a} | '+ ' | '.join(f'{r[k]:.1f}' for k in units)+' |')
lines += ['','## Wrapper versus buildInfo split','','Iteration-only includes native collection retrieval and all module wrappers. The paired read-minus-iteration difference includes buildInfo wrappers/getters, custom-object conversion and associated GC; it is not an isolated native microbenchmark.','','| Condition | Iteration 2.2.8 ms | Iteration canary ms | Read 2.2.8 ms | Read canary ms | Paired extra 2.2.8 ms | Paired extra canary ms | Canary read gain |','|---|---:|---:|---:|---:|---:|---:|---:|']
for s in ['cold','new','legacy','watch']:
 r=[groups[v,s,a]['tapMs'] for v,a in [('release','iterate'),('canary','iterate'),('release','read'),('canary','read')]]
 diffs=[]
 for v in ['release','canary']:
  samples={d['replicate']:d['results'][-1]['tapMs'] for d in rows if d['version']==v and d['scenario']==s and d['access']=='read'}
  iters={d['replicate']:d['results'][-1]['tapMs'] for d in rows if d['version']==v and d['scenario']==s and d['access']=='iterate'}
  diffs.append(med(samples[k]-iters[k] for k in samples))
 gain=(1-r[3]/r[2])*100
 lines.append(f'| {s} | '+' | '.join(f'{x:.1f}' for x in r+diffs)+f' | {gain:.1f}% |')
lines += ['','## Read-tap memory comparison','','| Condition | Canary peak versus 2.2.8 | Canary end versus 2.2.8 |','|---|---:|---:|']
for s in ['cold','new','legacy','watch']:
 a=groups['release',s,'read'];b=groups['canary',s,'read']
 lines.append(f"| {s} | {b['peakMiB']-a['peakMiB']:+.1f} MiB ({(b['peakMiB']/a['peakMiB']-1)*100:+.1f}%) | {b['endMiB']-a['endMiB']:+.1f} MiB ({(b['endMiB']/a['endMiB']-1)*100:+.1f}%) |")
lines += ['','## Tap range and whole-process accounting','','Whole-process figures include module loading, compiler construction/close and output verification; watch whole-process figures include the initial compilation and the rebuild and are not the rebuild-only values in the main table.','','| Binary | Condition | Tap | Tap min–max ms | Process wall ms | Process peak MiB |','|---|---|---|---:|---:|---:|']
for v,s,a in groups:
 r=groups[v,s,a]
 lines.append(f"| {v} | {s} | {a} | {r['tapMinMs']:.1f}–{r['tapMaxMs']:.1f} | {r['wallProcessMs']:.1f} | {r['peakProcessMiB']:.1f} |")
lines += ['','## Output parity','', '```json', (root/'parity.json').read_text().rstrip(), '```']
(root/'tables.md').write_text('\n'.join(lines)+'\n')
(root/'aggregate.json').write_text(json.dumps({ '|'.join(k):v for k,v in groups.items()},indent=2)+'\n')
print('\n'.join(lines))
