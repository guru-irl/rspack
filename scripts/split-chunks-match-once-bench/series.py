import argparse,hashlib,json,os,platform,re,shutil,subprocess,sys,time
from pathlib import Path
from paired_stats import summarize
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('core',type=Path);p.add_argument('--fixture',type=Path);p.add_argument('--pairs',type=int,default=10);args=p.parse_args()
root=args.root.resolve();core=args.core.resolve();fixture=(args.fixture or root/'fixture').resolve();results=root/'results';results.mkdir(exist_ok=True,parents=True)
assert args.pairs>=10
labels=('base','base-prime','change')
binding=lambda label:root/'bindings'/('base' if label=='base-prime' else label)/'binding.node'
manifest={'host':platform.platform(),'cpuCount':os.cpu_count(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'pairs':args.pairs,'warmupsExcluded':1,'samples':[],'failures':[],'bindings':{k:hashlib.sha256(binding(k).read_bytes()).hexdigest() for k in labels},'sourceCommits':{k:(root/'bindings'/k/'commit.sha').read_text().strip() for k in ('base','change')},'memoryGateMetrics':['peakMiB','rebuild/steadyMiB','revert/steadyMiB']}
assert manifest['bindings']['base']==manifest['bindings']['base-prime']
write_manifest=lambda:(results/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
write_manifest()

def sample(arm,label,pair):
 condition={}
 if sys.platform=='linux' and shutil.disk_usage(root).free<30*10**9:raise RuntimeError('Disk below 30 GB')
 name=f'{arm}-{pair:02d}-{label}';out=results/(name+'.json');assert not out.exists(),out
 env=dict(os.environ,RSPACK_BINDING=str(binding(label)),NODE_OPTIONS='--max-old-space-size=8192',MEASURE_MEMORY='1',TMPDIR=str(root/'tmp'))
 for key in ('RAYON_NUM_THREADS','TOKIO_WORKER_THREADS','RSPACK_RAYON_STATS','RSPACK_RAYON_MARKS','MIMALLOC_PURGE_DELAY','SPLIT_CHUNKS_NATIVE_PROBE','VERIFY_DEST','NAPI_RS_NATIVE_LIBRARY_PATH'):env.pop(key,None)
 cmd=['node','--expose-gc',str(fixture/'run.mjs'),'--arm',arm,'--mode','development','--runs','1','--rspack',str(core),'--out',str(out)]
 if sys.platform=='darwin':env['MEASURE_FOOTPRINT']='1';cmd=['/usr/bin/time','-l',*cmd]
 else:env.pop('MEASURE_FOOTPRINT',None);cmd=[sys.executable,str(root/'scripts/monitor.py'),str(out),'--',*cmd]
 started=time.time()
 with (results/(name+'.log')).open('w') as stdout,(results/(name+'.time')).open('w') as stderr:
  done=subprocess.run(cmd,cwd=fixture,env=env,stdout=stdout,stderr=stderr,timeout=1200)
 if done.returncode:
  manifest['failures'].append({'name':name,'returncode':done.returncode});write_manifest()
  raise RuntimeError(f'{name}: exit {done.returncode}, not a sample; see log')
 j=json.loads(out.read_text());assert not j.get('error') and len(j['records'])==3
 if sys.platform=='darwin':
  assert j['host']['arch']=='arm64'
  peak=re.search(r'(\d+)\s+peak memory footprint',(results/(name+'.time')).read_text());assert peak
  j['processPeakBytes']=int(peak.group(1))
  for r in j['records']:r['steadyBytes']=r['steadyFootprint']
 else:
  m=json.loads(Path(str(out)+'.memory.json').read_text());assert m['returncode']==0 and m['samples']>100
  j['processPeakBytes']=m['peakBytes']
 out.write_text(json.dumps(j,indent=2)+'\n')
 manifest['samples'].append({'arm':arm,'label':label,'pair':pair,'warmup':pair==0,'seconds':time.time()-started,'condition':condition});write_manifest()
 print(name,'PASS',round(time.time()-started,2),flush=True);return j

summary={'contract':{'parity':True,'memoryIncrease':False},'comparisons':{},'method':'Paired Walsh-average Hodges-Lehmann; exact signed-rank 95% interval (symmetric location model), 10000 seeded paired bootstrap replicates. Increase: exact lower bound > 0. Win: exact upper bound < 0. A/A and within-triple contrast reported separately.'}
for arm in ('native','callback'):
 pairs=[]
 for i in range(args.pairs+1):
  order=labels if i%2 else tuple(reversed(labels));data={label:sample(arm,label,i) for label in order}
  for field in ('hashes','callbacks','modules','chunks'):
   expected=[r[field] for r in data['base']['records']]
   assert all([r[field] for r in data[label]['records']]==expected for label in labels),(arm,i,field,'CORRECTNESS FAILURE')
  if i:pairs.append(data)
 metrics={}
 getters={'wallMs':lambda r:r['wallMs'],'cpuMs':lambda r:r['cpuUserMs']+r['cpuSystemMs'],'processCacheGroupsMs':lambda r:r['processCacheGroupsMs'],'processCacheGroupsCpuMs':lambda r:r['splitChunks']['cpuUserMs']+r['splitChunks']['cpuSystemMs'],'steadyMiB':lambda r:r['steadyBytes']/2**20}
 for phase in ('cold','rebuild','revert'):
  for metric,fn in getters.items():
   values=[[fn(next(r for r in x[label]['records'] if r['build']==phase)) for x in pairs] for label in labels]
   metrics[phase+'/'+metric]={'AB':summarize(values[0],values[2]),'AA':summarize(values[0],values[1]),'BminusAprime':summarize(values[1],values[2])}
 values=[[x[label]['processPeakBytes']/2**20 for x in pairs] for label in labels]
 metrics['peakMiB']={'AB':summarize(values[0],values[2]),'AA':summarize(values[0],values[1]),'BminusAprime':summarize(values[1],values[2])}
 summary['comparisons'][arm]=metrics
 increases=[metric for metric in manifest['memoryGateMetrics'] if metrics[metric]['AB']['increase']]
 summary['contract']['memoryIncrease']|=bool(increases)
 (results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 for metric in ('rebuild/wallMs','rebuild/cpuMs','rebuild/processCacheGroupsMs',*manifest['memoryGateMetrics']):
  print('RESULT',arm,metric,json.dumps({c:{k:v for k,v in v.items() if k!='deltas'} for c,v in metrics[metric].items()}),flush=True)
 if increases:raise SystemExit('MEMORY_GATE_STOP '+arm+' '+','.join(increases))
print('ALL_ARMS_FINISHED',flush=True)
