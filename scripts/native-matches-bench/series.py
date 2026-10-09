import hashlib,itertools,json,os,platform,re,statistics,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]);core=Path(sys.argv[2]);results=root/'results';results.mkdir(exist_ok=True)
labels=('base','base-prime','change');n=5
binding=lambda label:root/'artifacts'/('base' if label=='base-prime' else label)/'binding.node'
manifest={'profile':'ci','counter':'exact requested Rust bytes; every nonzero delta; counter versus counter; diagnostic timings only','host':platform.platform(),'cpuCount':os.cpu_count(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'pairs':n,'warmupsExcluded':1,'samples':[],'bindings':{k:hashlib.sha256(binding(k).read_bytes()).hexdigest() for k in labels},'sourceCommits':{k:(root/'artifacts'/k/'commit.sha').read_text().strip() for k in ('base','change')}}
assert manifest['bindings']['base']==manifest['bindings']['base-prime']
def save(): (results/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
save();print('RUNNER',json.dumps(manifest),flush=True)
def sample(label,i):
 name=f'callback-{i:02d}-{label}';out=results/(name+'.json');heap=results/(name+'.heap.tsv')
 env=dict(os.environ,RSPACK_BINDING=str(binding(label)),NODE_OPTIONS='--max-old-space-size=8192',MEASURE_FOOTPRINT='1',RSPACK_LIVE_HEAP_LOG=str(heap),RSPACK_LIVE_HEAP_INTERVAL_MS='20')
 start=time.time()
 with (results/(name+'.log')).open('w') as stdout,(results/(name+'.time')).open('w') as stderr:
  done=subprocess.run(['/usr/bin/time','-l','node','--expose-gc','--require',str(root/'scripts/check-binding.cjs'),str(root/'fixture/run.mjs'),'--arm','callback','--mode','development','--runs','1','--rspack',str(core),'--out',str(out)],cwd=root/'fixture',env=env,stdout=stdout,stderr=stderr)
 if done.returncode:raise RuntimeError(f'{name} exit {done.returncode}; not a sample')
 j=json.loads(out.read_text());assert not j.get('error') and len(j['records'])==3 and j['host']['arch']=='arm64'
 peak=re.search(r'(\d+)\s+peak memory footprint',(results/(name+'.time')).read_text());assert peak
 rows=[list(map(int,l.split('\t'))) for l in heap.read_text().splitlines()[1:]];assert rows and all(len(r)==5 for r in rows)
 j['processPeakFootprint']=int(peak.group(1));j['processPeakRustHeap']=max(r[4] for r in rows)
 out.write_text(json.dumps(j,indent=2)+'\n')
 manifest['samples'].append({'label':label,'pair':i,'warmup':i==0,'seconds':time.time()-start,'load':os.getloadavg()});save();print(name,'PASS',flush=True);return j
pairs=[]
for i in range(n+1):
 order=labels if i%2 else tuple(reversed(labels));data={k:sample(k,i) for k in order}
 for field in ('hashes','callbacks'):
  expected=[r[field] for r in data['base']['records']];assert all([r[field] for r in data[k]['records']]==expected for k in labels)
 if i:pairs.append(data)
def summary(a,b):
 d=[y-x for x,y in zip(a,b)];nz=[x for x in d if x];ranks=[1+sum(abs(y)<abs(x) for y in nz)+(sum(abs(y)==abs(x) for y in nz)-1)/2 for x in nz]
 observed=sum(r for r,x in zip(ranks,nz) if x>0);v=[sum(r for r,b in zip(ranks,bits) if b) for bits in itertools.product((0,1),repeat=len(nz))]
 p=min(1,2*min(sum(x<=observed for x in v),sum(x>=observed for x in v))/len(v)) if nz else 1
 return {'n':len(d),'baseMedian':statistics.median(a),'otherMedian':statistics.median(b),'pairedMedian':statistics.median(d),'range':[min(d),max(d)],'lower':sum(x<0 for x in d),'higher':sum(x>0 for x in d),'exactWilcoxon':p,'pairs':list(zip(a,b,d))}
metrics={}
def add(name,fn):
 values={k:[fn(x[k]) for x in pairs] for k in labels}
 metrics[name]={'AA':summary(values['base'],values['base-prime']),'AB':summary(values['base'],values['change']),'contrast':summary(values['base-prime'],values['change'])}
add('processPeakRustMiB',lambda p:p['processPeakRustHeap']/2**20)
add('processPeakFootprintMiB',lambda p:p['processPeakFootprint']/2**20)
for phase in ('cold','rebuild','revert'):
 for name,fn in {'rustLiveMiB':lambda r:r['liveHeap']['liveBytes']/2**20,'footprintMiB':lambda r:r['steadyFootprint']/2**20,'jsHeapMiB':lambda r:r['jsMemory']['heapUsed']/2**20,'externalMiB':lambda r:r['jsMemory']['external']/2**20}.items():
  add(phase+'/'+name,lambda p,phase=phase,fn=fn:fn(next(r for r in p['records'] if r['build']==phase)))
(results/'summary.json').write_text(json.dumps(metrics,indent=2)+'\n');print('COUNTER_SERIES_PARITY_PASS',flush=True)
