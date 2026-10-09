import hashlib,itertools,json,os,platform,re,statistics,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]);core=Path(sys.argv[2]);results=root/'results';results.mkdir(exist_ok=True)
labels=('base','base-prime','change');pairs_count=7
binding=lambda label:root/'artifacts'/('base' if label=='base-prime' else label)/'binding.node'
manifest={'profile':'ci','host':platform.platform(),'cpuCount':os.cpu_count(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'pairs':pairs_count,'warmupsExcluded':1,'samples':[],'bindings':{k:hashlib.sha256(binding(k).read_bytes()).hexdigest() for k in labels},'sourceCommits':{k:(root/'artifacts'/k/'commit.sha').read_text().strip() for k in ('base','change')}}
assert manifest['bindings']['base']==manifest['bindings']['base-prime']
(results/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print('RUNNER',json.dumps(manifest),flush=True)
def sample(arm,label,pair):
 name=f'{arm}-{pair:02d}-{label}';out=results/(name+'.json')
 env=dict(os.environ,RSPACK_BINDING=str(binding(label)),NODE_OPTIONS='--max-old-space-size=8192',MEASURE_FOOTPRINT='1')
 start=time.time()
 with (results/(name+'.log')).open('w') as stdout,(results/(name+'.time')).open('w') as stderr:
  done=subprocess.run(['/usr/bin/time','-l','node','--expose-gc','--require',str(root/'scripts/check-binding.cjs'),str(root/'fixture/run.mjs'),'--arm',arm,'--mode','development','--runs','1','--rspack',str(core),'--out',str(out)],cwd=root/'fixture',env=env,stdout=stdout,stderr=stderr)
 if done.returncode:raise RuntimeError(f'{name}: exit {done.returncode}, not a sample')
 j=json.loads(out.read_text());assert not j.get('error') and len(j['records'])==3
 assert j['host']['arch']=='arm64'
 peak=re.search(r'(\d+)\s+peak memory footprint',(results/(name+'.time')).read_text());assert peak
 j['processPeakFootprint']=int(peak.group(1));out.write_text(json.dumps(j,indent=2)+'\n')
 manifest['samples'].append({'arm':arm,'label':label,'pair':pair,'warmup':pair==0,'seconds':time.time()-start,'load':os.getloadavg()});(results/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print(name,'PASS',flush=True);return j
def summarize(a,b):
 d=[y-x for x,y in zip(a,b)];nz=[x for x in d if x]
 ranks=[1+sum(abs(y)<abs(x) for y in nz)+(sum(abs(y)==abs(x) for y in nz)-1)/2 for x in nz]
 observed=sum(r for r,x in zip(ranks,nz) if x>0);values=[sum(r for r,v in zip(ranks,bits) if v) for bits in itertools.product((0,1),repeat=len(nz))]
 p=min(1,2*min(sum(v<=observed for v in values),sum(v>=observed for v in values))/len(values)) if nz else 1
 return {'n':len(d),'baseMedian':statistics.median(a),'otherMedian':statistics.median(b),'pairedMedian':statistics.median(d),'range':[min(d),max(d)],'lower':sum(x<0 for x in d),'equal':sum(x==0 for x in d),'higher':sum(x>0 for x in d),'exactWilcoxon':p,'pairs':list(zip(a,b,d))}
def comparison(a,ap,b):
 aa=summarize(a,ap);ab=summarize(a,b);contrast=summarize(ap,b)
 amplitude=max(abs(x[2]) for x in aa['pairs'])
 signal=contrast['pairedMedian']>0 and contrast['exactWilcoxon']<.05
 return {'AA':aa,'AB':ab,'contrastBminusAprime':contrast,'aaMaxAbsoluteDelta':amplitude,'withinObservedAASpread':ab['pairedMedian']<=amplitude,'consistentPositiveContrast':signal,'noiseAwareDiagnosticPass':ab['pairedMedian']<=amplitude and not signal}
summary={};gates={}
for arm in ('native','callback'):
 pairs=[]
 for i in range(pairs_count+1):
  order=labels if i%2 else tuple(reversed(labels))
  data={label:sample(arm,label,i) for label in order}
  for field in ('hashes','callbacks'):
   expected=[r[field] for r in data['base']['records']]
   assert all([r[field] for r in data[label]['records']]==expected for label in labels)
  if i:pairs.append(data)
 metrics={}
 for phase in ('cold','rebuild','revert'):
  for metric,fn in {'compileMs':lambda r:r['compileMs'],'wallMs':lambda r:r['wallMs'],'cpuMs':lambda r:r['cpuUserMs']+r['cpuSystemMs'],'splitWallMs':lambda r:r['splitChunks']['wallMs'],'splitCpuMs':lambda r:r['splitChunks']['cpuUserMs']+r['splitChunks']['cpuSystemMs'],'steadyMiB':lambda r:r['steadyFootprint']/2**20}.items():
   def values(label):return [fn(next(r for r in x[label]['records'] if r['build']==phase)) for x in pairs]
   metrics[phase+'/'+metric]=comparison(values('base'),values('base-prime'),values('change'))
 metrics['peakMiB']=comparison(*[[x[label]['processPeakFootprint']/2**20 for x in pairs] for label in labels])
 summary[arm]=metrics
 for metric in ('rebuild/wallMs','rebuild/cpuMs'):gates[arm+'/'+metric]=metrics[metric]['noiseAwareDiagnosticPass']
summary['timingDiagnostics']=gates
summary['interpretation']='Compare paired AB with same-binary AA spread and the within-triple B-minus-Aprime contrast. No independent-samples assumption or equivalence claim. Diagnostics hold on positive paired contrast p<.05 or AB median outside observed AA spread; review raw rows before acceptance.'
(results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
if not all(gates.values()):raise SystemExit('MACOS_NOISE_AWARE_TIMING_REQUIRES_REVIEW')
