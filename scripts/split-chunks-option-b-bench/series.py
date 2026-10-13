import hashlib,json,os,platform,re,subprocess,sys,time
from pathlib import Path
from paired_stats import summarize
root=Path(sys.argv[1]).resolve();repo=Path(sys.argv[2]).resolve();system=os.environ['RUNNER_OS']
results=root/'results';results.mkdir(parents=True,exist_ok=True)
native_filters_only=os.environ.get('BENCH_NATIVE_FILTERS_ONLY')=='1'
labels=['main','main-prime','pr1'] if native_filters_only else ['main','main-prime','pr1','pr2']
if system=='Linux' and not native_filters_only:labels.insert(2,'old24')
def artifact(label):return root/'bindings'/('optb-binding-'+system+'-'+('main' if label=='main-prime' else label))
manifest={'host':platform.platform(),'cpuCount':os.cpu_count(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'pairs':10,'samples':[],'failures':[],'memoryGateMetrics':[p+'/'+m for p in ('cold','rebuild','revert') for m in ('peakMiB','steadyMiB')]+['wholePeakMiB'],'bindings':{k:hashlib.sha256((artifact(k)/'binding.node').read_bytes()).hexdigest() for k in labels},'commits':{k:(artifact(k)/'commit.sha').read_text().strip() for k in labels}}
assert manifest['bindings']['main']==manifest['bindings']['main-prime']
def save():(results/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
save()
for label in labels:
 core=artifact(label)/'core'
 for name,target in [('node_modules',repo/'packages/rspack/node_modules'),('compiled',repo/'packages/rspack/compiled')]:
  if not (core/name).exists():
   if sys.platform=='win32':subprocess.run(['cmd','/c','mklink','/J',str(core/name),str(target)],check=True,stdout=subprocess.DEVNULL)
   else:(core/name).symlink_to(target,target_is_directory=True)
summary={'method':'Ten ABBA pairs; paired Hodges-Lehmann estimate, inverted exact signed-rank 95% interval and 10000 paired bootstrap HL replicates. Increase: lower bound > 0; win: upper bound < 0. Peaks are cumulative through each checkpoint.','comparisons':{},'contract':{'parity':True,'memoryIncrease':False},'failures':[]}

def sample(arm,label,pair):
 name=f'{arm}-{pair:02d}-{label}';out=results/(name+'.json');assert not out.exists()
 env=dict(os.environ,RSPACK_BINDING=str(artifact(label)/'binding.node'),NAPI_RS_NATIVE_LIBRARY_PATH=str(artifact(label)/'binding.node'),NODE_OPTIONS='--max-old-space-size=8192',MEASURE_MEMORY='1',TMPDIR=str(root/'tmp'))
 for key in ('RAYON_NUM_THREADS','TOKIO_WORKER_THREADS','RSPACK_RAYON_STATS','RSPACK_RAYON_MARKS','MIMALLOC_PURGE_DELAY','SPLIT_CHUNKS_NATIVE_PROBE','VERIFY_DEST'):env.pop(key,None)
 core=artifact(label)/'core'
 if arm=='gate':
  env.update(SC_FIXTURE_ROOT=str(root/'gate-fixture'),SC_RESULT=str(out),SC_CORE=str(core/'dist/index.js'))
  cmd=['node','--expose-gc',str(root/'scripts/gate-run.mjs')]
 else:
  cmd=['node','--expose-gc',str(root/'fixture/run.mjs'),'--arm',arm,'--mode','development','--runs','1','--rspack',str(core),'--out',str(out)]
  if sys.platform=='darwin':env['MEASURE_FOOTPRINT']='1';cmd=['/usr/bin/time','-l',*cmd]
  else:cmd=[sys.executable,str(root/'scripts/monitor.py'),str(out),'--',*cmd]
 started=time.time()
 with (results/(name+'.log')).open('w') as stdout,(results/(name+'.time')).open('w') as stderr:
  done=subprocess.run(cmd,cwd=root/'fixture',env=env,stdout=stdout,stderr=stderr,timeout=1200)
 if done.returncode:
  manifest['failures'].append({'name':name,'returncode':done.returncode});save();raise RuntimeError(f'{name}: exit {done.returncode}; not a sample')
 j=json.loads(out.read_text());assert not j.get('error') and len(j['records'])==3
 if arm!='gate':
  if sys.platform=='darwin':
   assert j['host']['arch']=='arm64';peak=re.search(r'(\d+)\s+peak memory footprint',(results/(name+'.time')).read_text());assert peak
   j['processPeakBytes']=int(peak.group(1))
   for record in j['records']:record['steadyBytes']=record['steadyFootprint'];record['peakBytes']=record['peakFootprint']
  else:
   m=json.loads(Path(str(out)+'.memory.json').read_text());assert m['returncode']==0 and m['samples']>100;j['processPeakBytes']=m['peakBytes']
 out.write_text(json.dumps(j,indent=2)+'\n')
 manifest['samples'].append({'arm':arm,'label':label,'pair':pair,'warmup':pair==0,'seconds':time.time()-started});save()
 print(name,'PASS',round(time.time()-started,2),flush=True);return j

arms=('native-type','layer') if native_filters_only else (('callback','native','native-type','layer','gate') if system=='Linux' else ('native','callback','native-type','layer'))
all_labels=labels
for arm in arms:
 labels=['main','main-prime','pr1'] if arm in ('native-type','layer') else all_labels
 pairs=[]
 for i in range(11):
  order=labels if i%2 else list(reversed(labels));data={label:sample(arm,label,i) for label in order}
  for field in ('hashes','modules','chunks'):
   expected=[r[field] for r in data['main']['records']]
   assert all([r[field] for r in data[label]['records']]==expected for label in labels),(arm,i,field,'CORRECTNESS FAILURE')
  field='counts' if arm=='gate' else 'callbacks'
  assert all([r[field] for r in data[label]['records']]==[r[field] for r in data['main']['records']] for label in labels if label!='old24'),(arm,i,'callback counts','CORRECTNESS FAILURE')
  if i:pairs.append(data)
 comps=[('AA','main','main-prime'),('main-pr1','main','pr1')]
 if 'pr2' in labels:comps += [('main-pr2','main','pr2'),('pr1-pr2','pr1','pr2')]
 if 'old24' in labels:comps += [('main-24','main','old24'),('24-pr2','old24','pr2'),('24-pr1','old24','pr1')]
 metrics={}
 def row(label,phase,pair):return next(r for r in pair[label]['records'] if r.get('build',r.get('phase'))==phase)
 getters={'wallMs':lambda r:r['wallMs'],'processCacheGroupsMs':lambda r:r['processCacheGroupsMs']}
 if arm!='gate':getters.update(cpuMs=lambda r:r['cpuUserMs']+r['cpuSystemMs'],splitChunksWallMs=lambda r:r['splitChunks']['wallMs'],splitChunksCpuMs=lambda r:r['splitChunks']['cpuUserMs']+r['splitChunks']['cpuSystemMs'],steadyMiB=lambda r:r['steadyBytes']/2**20,peakMiB=lambda r:r['peakBytes']/2**20)
 phases=('cold','edit','revert') if arm=='gate' else ('cold','rebuild','revert')
 for phase in phases:
  for metric,fn in getters.items():metrics[phase+'/'+metric]={key:summarize([fn(row(a,phase,x)) for x in pairs],[fn(row(b,phase,x)) for x in pairs]) for key,a,b in comps}
 if arm!='gate':
  metrics['wholePeakMiB']={key:summarize([x[a]['processPeakBytes']/2**20 for x in pairs],[x[b]['processPeakBytes']/2**20 for x in pairs]) for key,a,b in comps}
  def cpu(label,x):return sum(row(label,p,x)['cpuUserMs']+row(label,p,x)['cpuSystemMs'] for p in ('cold','rebuild'))
  metrics['cold+rebuild/cpuMs']={key:summarize([cpu(a,x) for x in pairs],[cpu(b,x) for x in pairs]) for key,a,b in comps}
  increases=[(m,k) for m in manifest['memoryGateMetrics'] for k in ('main-pr1','main-pr2') if k in metrics[m] and metrics[m][k]['increase']]
  summary['contract']['memoryIncrease']|=bool(increases)
  if increases:summary['failures'] += [{'arm':arm,'memoryIncrease':increases}]
 summary['comparisons'][arm]=metrics
 (results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 print('ARM_FINISHED',arm,'memoryIncrease',summary['contract']['memoryIncrease'],flush=True)
if system=='Linux' and not native_filters_only:
 cb=summary['comparisons']['callback']
 keep=cb['cold+rebuild/cpuMs']['main-pr2']['hl']/cb['cold+rebuild/cpuMs']['main-24']['hl'] if cb['cold+rebuild/cpuMs']['main-24']['hl']<0 else None
 summary['deciding']={'cpuSavingRetained':keep,'callbackRebuildWallIncrease':cb['rebuild/wallMs']['24-pr2']['increase'],'gateEditTimerIncrease':summary['comparisons']['gate']['edit/processCacheGroupsMs']['24-pr2']['increase']}
 (results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 print('DECIDING',json.dumps(summary['deciding']),flush=True)
print('ALL_ARMS_FINISHED',flush=True)
if summary['contract']['memoryIncrease']:raise SystemExit('MEMORY_GATE_STOP')
