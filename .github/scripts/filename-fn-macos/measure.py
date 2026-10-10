from pathlib import Path
import subprocess,sys,os,json,re,statistics,itertools,platform
root=Path(sys.argv[1]).resolve();results=root/'results';results.mkdir(parents=True,exist_ok=True)
script=Path(__file__).resolve().parent
if platform.machine()!='arm64':raise RuntimeError('requires macOS arm64')
groups={a:[]for a in ['base','baseprime','R']};parity=[]
for sample in range(5):
 order=['base','baseprime','R'];offset=sample%3;order=order[offset:]+order[:offset];manifests={}
 for arm in order:
  source='R'if arm=='R'else'base';tree=root/'arms'/source
  env=dict(os.environ);env.update(FILENAME_MEASURE='1',FILENAME_FIXTURE=str(root/'fixture'),FILENAME_FOOTPRINT=str(root/'footprint.node'),NAPI_RS_NATIVE_LIBRARY_PATH=str(tree/'native.node'))
  prefix=results/f'{sample}-{arm}'
  with prefix.with_suffix('.stdout.jsonl').open('w')as out,prefix.with_suffix('.stderr.log').open('w')as err:
   p=subprocess.run(['node','--expose-gc',str(script/'sample.cjs'),str(tree),'fn'],env=env,stdout=out,stderr=err,timeout=240)
  if p.returncode:raise RuntimeError(f'failed sample {sample}/{arm}, rc={p.returncode}')
  values=[json.loads(s)for s in prefix.with_suffix('.stdout.jsonl').read_text().splitlines()if s.startswith('{')]
  m=next(x for x in values if x.get('type')=='metrics');manifests[arm]=next(x['manifest']for x in values if x.get('type')=='manifest');marks={}
  for name,edge,epoch in re.findall(r'FILENAME_PASS (hashing|create chunk assets) (start|end) (\d+)',prefix.with_suffix('.stderr.log').read_text()):marks.setdefault(name,{})[edge]=int(epoch)/1000
  windows={}
  for name,e in marks.items():
   lo,hi=e['start'],e['end'];calls=sum(lo<=x[0]<=hi for x in m['calls']);turns=[x for x in m['rawTurns']if lo<=x[0]<=hi]
   windows[name]={'ms':hi-lo,'callbackCalls':calls,'jsRoundTrips':len(turns)+calls-sum(x[2]for x in turns)}
  assert set(windows)=={'hashing','create chunk assets'}
  if arm=='R':assert m['rawTurns']and max(t[2]for t in m['rawTurns'])<=512
  m={k:v for k,v in m.items()if k not in ['calls','rawTurns','traces','logging']};m['windows']=windows;m['sample']=sample;m['arm']=arm
  prefix.with_suffix('.summary.json').write_text(json.dumps(m,indent=2)+'\n');groups[arm].append(m)
  print('Sample complete',sample,arm,m['wallMs'],m['endMemory']['physFootprint'],flush=True)
 assert manifests['base']==manifests['baseprime']==manifests['R'],f'normalized output parity failed for triple {sample}'
 parity.append({'triple':sample,'files':len(manifests['base']),'parity':True,'normalization':'embedded .h literal only'})
def exact(ds):
 xs=[d for d in ds if d!=0];n=len(xs)
 if not n:return {'n':0,'pTwoSided':1.0,'W':0}
 indices=sorted(range(n),key=lambda i:abs(xs[i]));ranks=[0.0]*n;lo=0
 while lo<n:
  hi=lo+1
  while hi<n and abs(xs[indices[hi]])==abs(xs[indices[lo]]):hi+=1
  for j in range(lo,hi):ranks[indices[j]]=(lo+1+hi)/2
  lo=hi
 plus=sum(r for r,x in zip(ranks,xs)if x>0);total=sum(ranks);distance=abs(2*plus-total)
 p=sum(abs(2*sum(r*s for r,s in zip(ranks,bits))-total)>=distance for bits in itertools.product([0,1],repeat=n))/(2**n)
 return {'n':n,'W':min(plus,total-plus),'pTwoSided':p,'method':'exact conditional sign enumeration; average ranks for ties; zeros discarded'}
def value(x,k):
 if k=='wallMs':return x[k]
 if k.startswith('hash_'):return x['windows']['hashing'][k[5:]]
 if k.startswith('assets_'):return x['windows']['create chunk assets'][k[7:]]
 if k=='peakPhysFootprint':return x['endMemory'][k]
 if k=='endPhysFootprint':return x['endMemory']['physFootprint']
 if k=='postGcPhysFootprint':return x['postGcMemory']['physFootprint']
 if k=='postGcHeapUsed':return x['postGcMemory']['usage']['heapUsed']
 if k=='postGcV8Physical':return x['postGcMemory']['heap']['total_physical_size']
metrics={}
for key in ['wallMs','hash_ms','assets_ms','hash_jsRoundTrips','assets_jsRoundTrips','peakPhysFootprint','endPhysFootprint','postGcPhysFootprint','postGcHeapUsed','postGcV8Physical']:
 vals={a:[value(x,key)for x in xs]for a,xs in groups.items()}
 def contrast(left,right):
  ds=[x-y for x,y in zip(vals[left],vals[right])]
  return {'pairedMedianDelta':statistics.median(ds),'differences':ds,'exactWilcoxon':exact(ds),'signCounts':{'positive':sum(x>0 for x in ds),'negative':sum(x<0 for x in ds),'zero':sum(x==0 for x in ds)}}
 metrics[key]={'medians':{a:statistics.median(v)for a,v in vals.items()},'samples':vals,'AA':contrast('baseprime','base'),'RBase':contrast('R','base'),'RBaseprime':contrast('R','baseprime')}
report={'runner':{'platform':platform.platform(),'machine':platform.machine(),'cpus':os.cpu_count(),'node':subprocess.check_output(['node','--version'],text=True).strip()},'chunks':int(os.environ.get('FILENAME_CHUNKS','5000')),'scaledDown':False,'triples':5,'parity':parity,'metrics':metrics,'physFootprintMethod':'Mach TASK_VM_INFO self task, including ledger_phys_footprint_peak at build end; end and live-compilation post-two-GC snapshots; not RSS substitution','sourceShas':{a:(root/'arms'/a/'source.sha').read_text().strip()for a in ['base','R']}}
(root/'macos-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
