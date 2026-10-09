import subprocess,json,time,resource,hashlib,shutil,os
from pathlib import Path
root=Path(os.environ.get('BUILDINFO_BENCH_DIR','.bench/buildinfo-access')).resolve()
script=Path(__file__).parent
fixture_info=json.loads((root/'fixture.json').read_text())
runs=root/'runs';runs.mkdir(exist_ok=True)
cores={version:root/version/'node_modules/@rspack/core/dist/index.js' for version in ['release','canary']}
summary=[]

def run(version,scenario,access,label,seed=False):
    record=runs/f'{label}-{version}-{scenario}-{access}.json'
    logfile=record.with_suffix('.log')
    before=resource.getrusage(resource.RUSAGE_CHILDREN)
    t0=time.monotonic_ns()
    with logfile.open('w') as log:
      p=subprocess.Popen(['node','--max-old-space-size=8192',str(script/'run.mjs'),str(cores[version]),version,scenario,access,str(record)],stdout=log,stderr=subprocess.STDOUT)
      proc=Path(f'/proc/{p.pid}/status');samples=[];peak=0;last=0
      while p.poll() is None:
        t=time.monotonic_ns()
        try:
          vals=dict((line.split(':',1)[0],line.split(':',1)[1].strip()) for line in proc.read_text().splitlines() if ':' in line)
          last=int(vals.get('RssAnon','0 kB').split()[0]);peak=max(peak,last)
          samples.append((t,last))
        except (FileNotFoundError,ProcessLookupError):pass
        time.sleep(.02)
      rc=p.wait()
    elapsed=(time.monotonic_ns()-t0)/1e6
    after=resource.getrusage(resource.RUSAGE_CHILDREN)
    if rc:raise RuntimeError(f'{record.name} exit={rc}; {logfile.read_text()[-4000:]}')
    data=json.loads(record.read_text())
    events=[json.loads(l) for l in Path(str(record)+'.events').read_text().splitlines()]
    for stage,r in enumerate(data['results']):
      start=int(next(e['timeNs'] for e in events if e['name']=='start' and e['stage']==stage))
      end=int(next(e['timeNs'] for e in events if e['name']=='done' and e['stage']==stage))
      r['peakRssAnonKiB']=max([v for t,v in samples if start<=t<=end]+[r['endRssAnonKiB'],r['tapEndRssAnonKiB']])
    data.update(processWallMs=elapsed,processCpuUserMs=(after.ru_utime-before.ru_utime)*1000,processCpuSysMs=(after.ru_stime-before.ru_stime)*1000,processPeakRssAnonKiB=peak,sampleIntervalMs=20,seed=seed,replicate=label)
    record.write_text(json.dumps(data,indent=2)+'\n')
    (record.with_suffix('.rss.json')).write_text(json.dumps(samples))
    print(json.dumps({'record':str(record),'wallMs':elapsed,'peakMiB':peak/1024,'results':data['results']}),flush=True)
    summary.append(data)
    (root/'raw-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    return data

# All conditions use the one fixture and output directory. Fresh processes per warm sample.
# Separate version/access/cache directories avoid cross-binary and cross-tap contamination.
for access in ['read','iterate']:
  for scenario in ['new','legacy']:
    for version in ['release','canary']:
      cache=root/'caches'/f'{version}-{scenario}-{access}'
      if cache.exists():shutil.rmtree(cache)
      data=run(version,scenario,access,'seed',True)
      assert data['results'][0]['loaderCalls']==fixture_info['leaves'],data
      assert cache.exists() and any(cache.rglob('*')),f'No cache files {cache}'
# Interleave binaries in each pair; reverse binary order on alternating replicates.
# Finish warm-cache samples before watch mutates any input mtimes.
for scenario in ['cold','new','legacy','watch']:
  for replicate in range(1,6):
    for access in ['read','iterate']:
      order=['release','canary'] if replicate%2 else ['canary','release']
      for version in order:
        data=run(version,scenario,access,f'r{replicate}')
        relevant=data['results'][-1]
        expected=0 if scenario in ['new','legacy'] else 1 if scenario=='watch' else fixture_info['leaves']
        assert relevant['loaderCalls']==expected,(version,scenario,access,'unexpected loader work',relevant)
# Verify output identity for both modes and versions; report differences rather than hiding them.
rows=[d for d in summary if not d['seed']]
values={r['outputValue'] for d in rows for r in d['results']}
assert values=={fixture_info['expectedValue']},values
hashes={r['sha256'] for d in rows for r in d['results']}
by_input={'original':set(),'watch-comment':set()}
for d in rows:
  for stage,r in enumerate(d['results']):
    key='watch-comment' if d['scenario']=='watch' and stage==1 else 'original'
    by_input[key].add(r['sha256'])
parity={'allOutputValuesEqual':True,'allOutputHashesEqual':len(hashes)==1,'allMatchedInputOutputHashesEqual':all(len(v)==1 for v in by_input.values()),'sha256sByInput':{k:sorted(v) for k,v in by_input.items()},'measuredProcesses':len(rows),'seedProcesses':8}
(root/'parity.json').write_text(json.dumps(parity,indent=2)+'\n')
assert parity['allMatchedInputOutputHashesEqual'],parity
print('MEASUREMENT_MATRIX_COMPLETE',flush=True)
