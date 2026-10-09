import hashlib,itertools,json,os,platform,re,statistics,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]);core=Path(sys.argv[2]);results=root/'results';results.mkdir(exist_ok=True)
manifest={'profile':'ci','host':platform.platform(),'cpuCount':os.cpu_count(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'pairs':5,'warmupsExcluded':1,'samples':[],'bindings':{k:hashlib.sha256((root/'artifacts'/k/'binding.node').read_bytes()).hexdigest() for k in ('base','change')}}
allpairs={}
def sample(arm,label,pair):
 name=f'{arm}-{pair:02d}-{label}';out=results/(name+'.json')
 env=dict(os.environ,RSPACK_BINDING=str(root/'artifacts'/label/'binding.node'),NODE_OPTIONS='--max-old-space-size=8192',MEASURE_FOOTPRINT='1')
 start=time.time()
 with (results/(name+'.log')).open('w') as stdout,(results/(name+'.time')).open('w') as stderr:
  done=subprocess.run(['/usr/bin/time','-l','node','--expose-gc','--require',str(root/'scripts/check-binding.cjs'),str(root/'fixture/run.mjs'),'--arm',arm,'--mode','development','--runs','1','--rspack',str(core),'--out',str(out)],cwd=root/'fixture',env=env,stdout=stdout,stderr=stderr)
 if done.returncode:raise RuntimeError(f'{name}: exit {done.returncode}, not a sample')
 j=json.loads(out.read_text());assert not j.get('error') and len(j['records'])==3
 peak=re.search(r'(\d+)\s+peak memory footprint',(results/(name+'.time')).read_text());assert peak
 j['processPeakFootprint']=int(peak.group(1));out.write_text(json.dumps(j,indent=2)+'\n')
 manifest['samples'].append({'arm':arm,'label':label,'pair':pair,'warmup':pair==0,'seconds':time.time()-start,'load':os.getloadavg()});(results/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print(name,'PASS',flush=True);return j
for arm in ('native','callback'):
 pairs=[]
 for i in range(6):
  order=('base','change') if i%2 else ('change','base')
  data={label:sample(arm,label,i) for label in order}
  assert [r['hashes'] for r in data['base']['records']]==[r['hashes'] for r in data['change']['records']]
  assert [r['callbacks'] for r in data['base']['records']]==[r['callbacks'] for r in data['change']['records']]
  if i:pairs.append(data)
 allpairs[arm]=pairs

def summarize(a,b):
 d=[y-x for x,y in zip(a,b)];nz=[x for x in d if x]
 ranks=[1+sum(abs(y)<abs(x) for y in nz)+(sum(abs(y)==abs(x) for y in nz)-1)/2 for x in nz]
 observed=sum(r for r,x in zip(ranks,nz) if x>0);values=[sum(r for r,v in zip(ranks,bits) if v) for bits in itertools.product((0,1),repeat=len(nz))]
 p=min(1,2*min(sum(v<=observed for v in values),sum(v>=observed for v in values))/len(values)) if nz else 1
 return {'base':[statistics.median(a),min(a),max(a)],'change':[statistics.median(b),min(b),max(b)],'pairedDelta':[statistics.median(d),min(d),max(d)],'lower':sum(x<0 for x in d),'equal':sum(x==0 for x in d),'higher':sum(x>0 for x in d),'wilcoxon':p,'pairs':list(zip(a,b,d))}
summary={};gates={}
for arm,pairs in allpairs.items():
 metrics={}
 for phase in ('cold','rebuild','revert'):
  for metric,fn in {'compileMs':lambda r:r['compileMs'],'wallMs':lambda r:r['wallMs'],'cpuMs':lambda r:r['cpuUserMs']+r['cpuSystemMs'],'splitWallMs':lambda r:r['splitChunks']['wallMs'],'steadyMiB':lambda r:r['steadyFootprint']/2**20}.items():
   def values(label):return [fn(next(r for r in x[label]['records'] if r['build']==phase)) for x in pairs]
   metrics[phase+'/'+metric]=summarize(values('base'),values('change'))
 metrics['peakMiB']=summarize([x['base']['processPeakFootprint']/2**20 for x in pairs],[x['change']['processPeakFootprint']/2**20 for x in pairs])
 summary[arm]=metrics
 for metric in ('rebuild/wallMs','rebuild/cpuMs'):
  m=metrics[metric];gates[arm+'/'+metric]=m['pairedDelta'][0]<=0 and m['lower']>=m['higher']
summary['timingGates']=gates
(results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
if not all(gates.values()):raise SystemExit('MACOS_TIMING_BAR_NOT_MET')
