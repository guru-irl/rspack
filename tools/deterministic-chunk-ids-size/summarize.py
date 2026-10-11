import json,statistics,re,os
from pathlib import Path
r=Path(os.environ['IDS_RESULT_ROOT'])
pairs=int(os.environ.get('IDS_PAIRS','3'))
rows=[];processes=[];warnings={};affected={};phase_rows=[]
for block in range(1,pairs+1):
 for arm in ['head','candidate']:
  d=json.loads((r/f'run-{block}-{arm}.json').read_text());samples=json.loads((r/f'rss-{block}-{arm}.json').read_text())
  processes.append({'block':block,'arm':arm,'peakMiB':max(x['processPeakRssKb'] for x in d['steps'])/1024,'medianSteadyMiB':statistics.median(x['steadyRssKb'] for x in d['steps'][1:])/1024})
  for x in d['steps']:
   warnings[f'{block}-{arm}-{x["step"]}']=x['warnings']
   if x['step']==0:continue
   window=[s['rssKb'] for s in samples if x['editStartEpoch']<=s['time']<=x['editEndEpoch']]
   assert window,('missing RSS samples',block,arm,x['step'])
   peak=max(window)
   rows.append({'block':block,'arm':arm,'edit':x['step'],'elapsedMs':x['elapsedMs'],'statsMs':x['statsMs'],'rebuildPeakMiB':peak/1024,'steadyMiB':x['steadyRssKb']/1024,'processHwmMiB':x['processPeakRssKb']/1024})
   phases={}
   for name,entries in x['logging'].items():
    if name.startswith('rspack.incremental'):
     affected[f'{block}-{arm}-{x["step"]}-{name}']=[e['message'] for e in entries]
    if name=='rspack.Compilation':
     for entry in entries:
      m=re.match(r'(.+): ([0-9.]+) ms$',entry['message'] or '')
      if m and m[1] in ['create module hashes','code generation','create hash','hashing: hash chunks','hashing: hash runtime chunks']:
       phases[m[1]]=float(m[2])
   phase_rows.append({'block':block,'arm':arm,'edit':x['step'],**phases})
summary={'parity':f'PASS: {pairs} paired blocks, each cold + 6 edits; direct file bytes and manifests identical','rows':rows,'processes':processes,'phases':phase_rows,'warnings':warnings,'affected':affected,'aggregate':{}}
for arm in ['head','candidate']:
 rr=[x for x in rows if x['arm']==arm];pp=[x for x in processes if x['arm']==arm]
 summary['aggregate'][arm]={k:statistics.median(x[k] for x in rr) for k in ['elapsedMs','statsMs','rebuildPeakMiB','steadyMiB']}
 summary['aggregate'][arm]['processPeakMiB']=statistics.median(x['peakMiB'] for x in pp)
 summary['aggregate'][arm]['phases']={k:statistics.median(x[k] for x in phase_rows if x['arm']==arm and k in x) for k in ['create module hashes','code generation','create hash','hashing: hash chunks','hashing: hash runtime chunks'] if any(x['arm']==arm and k in x for x in phase_rows)}
for k in ['elapsedMs','rebuildPeakMiB','steadyMiB','processPeakMiB']:
 a=summary['aggregate']['head'][k];b=summary['aggregate']['candidate'][k]
 summary.setdefault('changePercent',{})[k]=100*(b/a-1)
summary['idsDeterministicWarnings']=[w for k,ws in warnings.items() if '-candidate-' in k for w in ws if re.search('Deterministic(Module|Chunk)IdsPlugin',w)]
(r/'verification-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k in ['parity','aggregate','changePercent','idsDeterministicWarnings']},indent=2))
