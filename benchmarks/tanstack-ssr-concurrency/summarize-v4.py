import json,sys,statistics,hashlib
from pathlib import Path
w=Path(sys.argv[1]);output=Path(sys.argv[2])
arms=['gate-only','barrier','after-make','after-seal','after-emit']
labels=dict(zip(arms,['CONTROL','default','after-make','after-seal','after-emit']))
def read(d,name):return json.loads((d/name).read_text())
def valid(d):
 assert read(d,'exit.json')['status']==0,d
 assert read(d,'success.json')['passed'],d
 return d

def counts(d):
 builds=read(d,'builds.json')
 return {n:sum(b['name']==n for b in builds) for n in ['client','ssr']}
def log(d,arm):
 s=(d/'node-console.log').read_text()
 expected='disengaged reason=switch (TSS_SSR_CONCURRENT=0)' if arm=='gate-only' else 'engaged mode='+('default' if arm=='barrier' else arm)
 assert s.count('[tss-ssr-concurrency] '+expected+' gate=on')==1,d
 return expected+' gate=on'
result={'checks':[],'measurements':[],'costs':[],'failurePaths':[]}
reference=read(w/'cold-verified-gate-only','initial-outputs.json')
secondary=read(w/'non-pregenerated/cold-0-gate-only','initial-outputs.json')
gate_ref=read(w/'v4-cold-request-verified-gate-only','initial-outputs.json')
for arm in arms:
 d=valid(w/f'cold-verified-{arm}');initial=counts(d);assert initial=={'client':1,'ssr':1},d
 assert read(d,'initial-outputs.json')==reference,d
 noop=read(d,'route-tree-noop.json');assert noop['before']==noop['after'],d
 old=valid(w/f'non-pregenerated/cold-0-{arm}');old_counts=counts(old);assert old_counts=={'client':2,'ssr':2},old
 assert read(old,'initial-outputs.json')==secondary,old
 gate=valid(w/f'v4-cold-request-verified-{arm}');assert counts(gate)=={'client':1,'ssr':1},gate
 assert read(gate,'initial-outputs.json')==gate_ref,gate
 g=read(gate,'cold-request-gate.json');assert g['requests'][0]['started']<g['published'][0]<=g['requests'][0]['resolved'],gate
 pro=valid(w/f'production-verified-{arm}')
 for name in ['production-dependencies.json','production-taps.json','production-assets.json']:assert read(pro,name)==read(w/'production-verified-stock',name),(pro,name)
 assert '[tss-ssr-concurrency]' not in (pro/'console.log').read_text(),pro
 events=read(d,'events.json');make=next(e['t'] for e in events if e['name']=='ssr' and e['kind']=='make')
 boundary={'after-make':'finishMake','after-seal':'afterSeal','after-emit':'afterEmit','barrier':'afterDone','gate-only':'afterDone'}[arm]
 trigger=next(e['t'] for e in events if e['name']=='client' and e['kind']==boundary)
 assert make>=trigger,(arm,boundary,make,trigger)
 result['checks'].append({'arm':labels[arm],'productionParity':True,'coldByteParity':True,'startupLine':log(d,arm),'pregeneratedPasses':initial,'nonPregeneratedPasses':old_counts,'nonPregeneratedParity':True,'routeTree':noop,'requestGate':g,'coldTrigger':{'kind':boundary,'clientMs':trigger,'ssrMakeMs':make}})
 vals=[]
 for i in range(3):
  m=valid(w/f'cold-measure-{i}-{arm}');c=read(m,'cold.json');events=read(m,'events.json');rss=[s for s in read(m,'rss.json') if s.get('VmRSS',0)>0];assert rss
  assert counts(m)=={'client':1,'ssr':1},m
  start=next(e['t'] for e in events if e['name']=='ssr' and e['kind']=='done')-c['firstSsrDoneMs']
  ready=max(c['pageReadyMs'],c['finalReadyMs'])+start
  peak=max(s['VmRSS'] for s in rss);end=min(rss,key=lambda s:abs(s['wallMs']-c['endWallMs']))['VmRSS']
  row={'arm':labels[arm],'round':i,'readyMs':ready,'createToReadyMs':max(c['pageReadyMs'],c['finalReadyMs']),'peakRssBytes':peak,'endRssBytes':end,'endRssSelfBytes':c['endRss'],'samples':len(rss),'directory':m.name};vals.append(row);result['measurements'].append(row)
 result['costs'].append({'arm':labels[arm],'n':3,**{k:statistics.median(x[k] for x in vals) for k in ['readyMs','createToReadyMs','peakRssBytes','endRssBytes']}})
for arm in ['after-seal','after-emit']:
 for scenario in ['v4-compile-error','v4-client-error']:
  d=valid(w/f'{scenario}-verified-{arm}');r=read(d,'failure-recovery.json');assert r['passed'] and r['recovered']
  e=read(d,'events.json');initial=[x for x in e if x['step']=='initial'];assert any(x['name']=='ssr' and x['kind']=='done' for x in initial)
  if arm=='after-emit':assert not any(x['name']=='client' and x['kind']=='afterEmit' for x in initial),d
  r.update(arm=arm,scenario=scenario,clientSkippedEmit=not any(x['name']=='client' and x['kind']=='afterEmit' for x in initial));result['failurePaths'].append(r)
result['readyDefinition']='Node performance time origin to the later of all four compilers done and the first successful page response with expected loader data. Includes JS imports and Rsbuild creation; excludes the one-second settlement and subsequent parity requests.'
result['memoryDefinition']='Dev-server Node process only. /proc/PID/status VmRSS sampled every 10 ms from process launch through exit. Peak is the maximum over the whole process run; END is the sample nearest the post-ready/checkpoint marker, before server shutdown. RSS includes native Rspack allocations in that process. No GC is forced.'
result['orders']=read(w,'measurement-orders.json')
result['passed']=True
output.write_text(json.dumps(result,indent=2))
for r in result['costs']:print(f"| {r['arm']} | {r['readyMs']/1000:.3f} | {r['peakRssBytes']/1048576:.1f} | {r['endRssBytes']/1048576:.1f} |")
print('All evidence assertions PASS')
