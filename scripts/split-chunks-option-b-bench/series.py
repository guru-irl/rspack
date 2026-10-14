import hashlib,json,os,platform,re,subprocess,sys,time
from pathlib import Path
from paired_stats import summarize
root=Path(sys.argv[1]).resolve();repo=Path(sys.argv[2]).resolve();system=os.environ['RUNNER_OS']
results=root/'results';results.mkdir(parents=True,exist_ok=True)
replication=os.environ.get('BENCH_FOLLOWUPS_REPLICATION')=='1'
followups=replication or os.environ.get('BENCH_FOLLOWUPS')=='1'
native_filters_only=os.environ.get('BENCH_NATIVE_FILTERS_ONLY')=='1'
labels=['main','main-prime','pr1'] if native_filters_only else ['main','main-prime','pr1','pr2']
if followups:labels=['main','base38','base38-prime','name1024','rounds']
if replication:labels=['name1024','name1024-prime','rounds','old24']
if system=='Linux' and not native_filters_only:labels.insert(2,'old24')
def artifact(label):return root/'bindings'/('optb-binding-'+system+'-'+('main' if label=='main-prime' else 'base38' if label=='base38-prime' else 'name1024' if label=='name1024-prime' else label))
manifest={'host':platform.platform(),'cpuCount':os.cpu_count(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'pairs':10,'samples':[],'failures':[],'memoryGateMetrics':[p+'/'+m for p in ('cold','rebuild','revert') for m in ('peakMiB','steadyMiB')]+['wholePeakMiB'],'bindings':{k:hashlib.sha256((artifact(k)/'binding.node').read_bytes()).hexdigest() for k in labels},'commits':{k:(artifact(k)/'commit.sha').read_text().strip() for k in labels}}
if followups:
 if replication:assert manifest['bindings']['name1024']==manifest['bindings']['name1024-prime']
 else:assert manifest['bindings']['base38']==manifest['bindings']['base38-prime']
 expected={'main':'f2903b6482cb7a0fcdca912d23062bd94d3d5636','base38':'3482b2a8876fbb570a260137933110ff352d0306','base38-prime':'3482b2a8876fbb570a260137933110ff352d0306','name1024':'9f33615e8ddd9f1070dc3219f4d77f86993994d5','name1024-prime':'9f33615e8ddd9f1070dc3219f4d77f86993994d5','rounds':'f6e4ff3f55d54489301ecb0cee93bff17aec7eaa','old24':'297daff0ace33197c5e89f1c06359a5a0274fb71'}
 assert manifest['commits']=={k:expected[k] for k in labels},manifest['commits']
 if replication:
  assert system=='macOS'
  reused={'name1024': 'e13298b736377de536fffcd1d437a36cdaf42ba3689eecbaf8551d9eff3cc303', 'rounds': '55334ac3425a6e4fe42bbbe60e947bd4536cdbfa9d7ec056ac8beb2b02f444fc'}
  assert all(manifest['bindings'][k]==digest for k,digest in reused.items()),manifest['bindings']
else:assert manifest['bindings']['main']==manifest['bindings']['main-prime']
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
 manifest['samples'].append({'arm':arm,'label':label,'pair':pair,'warmup':pair<=0,'seconds':time.time()-started});save()
 print(name,'PASS',round(time.time()-started,2),flush=True);return j

arms=('native-type','layer') if native_filters_only else (('callback','native','native-type','layer','gate') if system=='Linux' else ('native','callback','native-type','layer'))
if followups:arms=('callback','native')
if replication:arms=('callback',)
all_labels=labels
for arm in arms:
 labels=['main','main-prime','pr1'] if arm in ('native-type','layer') else all_labels
 main_proof=sample(arm,'main',-1) if followups and not replication else None
 if followups:labels=[label for label in labels if label!='main']
 pairs=[]
 for i in range(11):
  order=labels if i%2 else list(reversed(labels));data={label:sample(arm,label,i) for label in order}
  reference=main_proof if main_proof else data['name1024'] if replication else data['main']
  for field in ('hashes','modules','chunks'):
   expected=[r[field] for r in reference['records']]
   assert all([r[field] for r in data[label]['records']]==expected for label in labels),(arm,i,field,'CORRECTNESS FAILURE')
  field='counts' if arm=='gate' else 'callbacks'
  assert all([r[field] for r in data[label]['records']]==[r[field] for r in reference['records']] for label in labels if followups or label!='old24'),(arm,i,'callback counts','CORRECTNESS FAILURE')
  if i:pairs.append(data)
 comps=[('AA','main','main-prime'),('main-pr1','main','pr1')]
 if 'pr2' in labels:comps += [('main-pr2','main','pr2'),('pr1-pr2','pr1','pr2')]
 if 'old24' in labels:comps += [('main-24','main','old24'),('24-pr2','old24','pr2'),('24-pr1','old24','pr1')]
 if followups:
  comps=[('AA','base38','base38-prime'),('base38-name1024','base38','name1024'),('name1024-rounds','name1024','rounds')]
  if 'old24' in labels:comps += [('old24-rounds','old24','rounds')]
 if replication:comps=[('AA','name1024','name1024-prime'),('name1024-rounds','name1024','rounds'),('old24-rounds','old24','rounds')]
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
  increases=[(m,k) for m in manifest['memoryGateMetrics'] for k in (('name1024-rounds','old24-rounds') if replication else ('base38-name1024','name1024-rounds') if followups else ('main-pr1','main-pr2')) if k in metrics[m] and metrics[m][k]['increase']]
  summary['contract']['memoryIncrease']|=bool(increases)
  if increases:summary['failures'] += [{'arm':arm,'memoryIncrease':increases}]
 summary['comparisons'][arm]=metrics
 (results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 print('ARM_FINISHED',arm,'memoryIncrease',summary['contract']['memoryIncrease'],flush=True)
if replication:
 cb=summary['comparisons']['callback']
 summary['deciding']={'primary':cb['revert/steadyMiB']['old24-rounds'],'replication':cb['revert/steadyMiB']['name1024-rounds']}
 (results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 print('DECIDING',json.dumps(summary['deciding']),flush=True)
if followups and system=='Linux':
 cb=summary['comparisons']['callback']
 summary['deciding']={'callbackRebuildWallIncrease':cb['rebuild/wallMs']['old24-rounds']['increase'],'callbackRebuildCpuIncrease':cb['rebuild/cpuMs']['old24-rounds']['increase'],'winsAgainstBases':{k:{m:cb['rebuild/'+m][k]['win'] for m in ('wallMs','cpuMs')} for k in ('base38-name1024','name1024-rounds')}}
 (results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 print('DECIDING',json.dumps(summary['deciding']),flush=True)
if system=='Linux' and not native_filters_only and not followups:
 cb=summary['comparisons']['callback']
 keep=cb['cold+rebuild/cpuMs']['main-pr2']['hl']/cb['cold+rebuild/cpuMs']['main-24']['hl'] if cb['cold+rebuild/cpuMs']['main-24']['hl']<0 else None
 summary['deciding']={'cpuSavingRetained':keep,'callbackRebuildWallIncrease':cb['rebuild/wallMs']['24-pr2']['increase'],'gateEditTimerIncrease':summary['comparisons']['gate']['edit/processCacheGroupsMs']['24-pr2']['increase']}
 (results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 print('DECIDING',json.dumps(summary['deciding']),flush=True)
print('ALL_ARMS_FINISHED',flush=True)
if summary['contract']['memoryIncrease'] and not followups:raise SystemExit('MEMORY_GATE_STOP')
