import json,collections,os
from pathlib import Path
root=Path(os.environ.get('BUILDINFO_BENCH_DIR','.bench/buildinfo-access')).resolve()
reports={}
for access in ['read','iterate']:
 name=f'canary-new-{access}'
 p=json.loads((root/'profiles'/f'{name}.cpuprofile').read_text())
 evs=[json.loads(l) for l in (root/'profiles'/f'{name}.json.events').read_text().splitlines()]
 start=int(next(e['timeNs'] for e in evs if e['name']=='tap-start'))/1000
 end=int(next(e['timeNs'] for e in evs if e['name']=='tap-end'))/1000
 nodes={n['id']:n for n in p['nodes']}
 counts=collections.Counter();weights=collections.Counter();t=p['startTime']
 assert p['startTime']<=start<=end<=p['endTime'],(p['startTime'],start,end,p['endTime'])
 for sample,delta in zip(p['samples'],p['timeDeltas']):
  t+=delta
  if start<=t<=end:
   frame=nodes[sample]['callFrame']
   label=f"{frame['functionName'] or '(anonymous)'} [{frame.get('url','')}:{frame.get('lineNumber',-1)+1}]"
   counts[label]+=1;weights[label]+=delta
 total=sum(weights.values())
 r=json.loads((root/'profiles'/f'{name}.json').read_text())['results'][0]
 assert r['loaderCalls']==0,r
 reports[access]={'tapMs':r['tapMs'],'tapSampleCount':sum(counts.values()),'sampleWeightMs':total/1000,'topSelfFrames':[{'frame':name,'samples':counts[name],'weightMs':weight/1000,'weightPercent':weight/total*100} for name,weight in weights.most_common(12)]}
(root/'profiles-summary.json').write_text(json.dumps(reports,indent=2)+'\n')
print(json.dumps(reports,indent=2))
