import copy,hashlib,json,os,platform,re,subprocess,sys,time
from pathlib import Path
from paired_stats import summarize

root=Path(sys.argv[1]).resolve();repo=Path(sys.argv[2]).resolve()
system=os.environ['RUNNER_OS'];results=root/'results'
results.mkdir(parents=True,exist_ok=True)
labels=['base','calibration','pr']
def artifact(label):return root/'bindings'/('absence-binding-'+system+'-'+('base' if label=='calibration' else label))
manifest={'host':platform.platform(),'cpuCount':os.cpu_count(),'pairs':10,'samples':[],
          'bindings':{k:hashlib.sha256((artifact(k)/'binding.node').read_bytes()).hexdigest() for k in labels},
          'commits':{k:(artifact(k)/'commit.sha').read_text().strip() for k in labels}}
assert manifest['commits']['base']=='cc2f2fa5cf1b910b7e0aaf379aba834e935c32c8'
assert manifest['commits']['pr']==os.environ['EXPECTED_PR_SHA']
assert manifest['bindings']['base']==manifest['bindings']['calibration']
def save():(results/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
save()
for label in ('base','pr'):
 core=artifact(label)/'core'
 for name,target in [('node_modules',repo/'packages/rspack/node_modules'),('compiled',repo/'packages/rspack/compiled')]:
  if not (core/name).exists():
   if sys.platform=='win32':subprocess.run(['cmd','/c','mklink','/J',str(core/name),str(target)],check=True,stdout=subprocess.DEVNULL)
   else:(core/name).symlink_to(target,target_is_directory=True)

def parity(a,b):
 assert len(a['records'])==len(b['records'])==3,'Missing output step'
 for x,y in zip(a['records'],b['records']):
  for field in ('phase','assets','membership','modules','chunks'):
   assert x[field]==y[field],f'PARITY_STOP: {x["phase"]} {field}'

def control(a):
 assert a['records'] and a['records'][0]['assets']
 parity(a,a)
 controls=[]
 for mutation in ('name','bytes','sha256','membership','missing-step'):
  bad=copy.deepcopy(a)
  if mutation=='missing-step':bad['records'].pop()
  elif mutation=='membership':
   chunk=next(iter(bad['records'][0]['membership']));bad['records'][0]['membership'][chunk]='bad'
  else:
   assets=bad['records'][0]['assets'];name=next(iter(assets))
   if mutation=='name':assets[name+'.changed']=assets.pop(name)
   elif mutation=='bytes':assets[name]['bytes']+=1
   else:assets[name]['sha256']='0'*64
  try:parity(a,bad)
  except AssertionError:controls.append(mutation)
  else:raise AssertionError('Parity control missed '+mutation)
 return controls

def sample(label,pair,variant='barrel'):
 name=f'{variant}-{pair:02d}-{label}';out=results/(name+'.json');assert not out.exists()
 env=dict(os.environ,RSPACK_BINDING=str(artifact(label)/'binding.node'),NAPI_RS_NATIVE_LIBRARY_PATH=str(artifact(label)/'binding.node'),EXPECTED_BINDING_SHA256=manifest['bindings'][label],NODE_OPTIONS='--max-old-space-size=8192',MEASURE_MEMORY='1',TMPDIR=str(root/'tmp'))
 for key in ('RAYON_NUM_THREADS','TOKIO_WORKER_THREADS','RSPACK_CODE_SPLITTING_CACHE_DEBUG','RSPACK_CODE_SPLITTING_CACHE_STABLE_ABSENCE'):
  env.pop(key,None)
 fixture=root/('fixture' if variant=='barrel' else 'stock-fixture')
 cmd=['node','--expose-gc',str(root/'scripts/run.mjs'),str(fixture),str(artifact(label)/'core'),str(out),variant]
 if sys.platform=='darwin':cmd=['/usr/bin/time','-l',*cmd]
 else:cmd=[sys.executable,str(root/'scripts/monitor.py'),str(out),'--',*cmd]
 started=time.time()
 with (results/(name+'.log')).open('w') as stdout,(results/(name+'.time')).open('w') as stderr:
  done=subprocess.run(cmd,cwd=repo,env=env,stdout=stdout,stderr=stderr,timeout=1200)
 if done.returncode:raise RuntimeError(f'{name}: exit {done.returncode}; not a sample')
 j=json.loads(out.read_text());assert not j.get('error') and len(j['records'])==3 and j['extraBuilds']==0
 assert j['bindingSha256']==manifest['bindings'][label]
 for r in j['records']:
  assert r['assets'] and r['modules']>=60701
  assert r['steadyBytes']>0 and r['peakBytes']>=r['steadyBytes']
 if sys.platform=='darwin':
  assert j['host']['arch']=='arm64'
  peak=re.search(r'(\d+)\s+peak memory footprint',(results/(name+'.time')).read_text());assert peak
  j['processPeakBytes']=int(peak.group(1))
 else:
  m=json.loads(Path(str(out)+'.memory.json').read_text());assert m['returncode']==0 and m['samples']>20
  j['processPeakBytes']=m['peakBytes']
 if variant=='barrel':
  for r in j['records'][1:]:
   assert r['topologyChanged']==(label!='pr'),(name,r)
   assert (r['rebuildGraphMs']>0)==(label!='pr'),(name,r)
 else:
  assert not any(r['topologyChanged'] for r in j['records'][1:]),'Stock fixture unexpectedly triggers topology rejection'
 assert j['records'][0]['assets']!=j['records'][1]['assets'],'Edit did not change output'
 assert j['records'][0]['assets']==j['records'][2]['assets'],'Revert did not restore output'
 out.write_text(json.dumps(j,indent=2)+'\n')
 manifest['samples'].append({'label':label,'pair':pair,'variant':variant,'warmup':pair==0,'seconds':time.time()-started});save()
 print(name,'PASS',round(time.time()-started,2),flush=True)
 return j

if os.environ.get('CHECK_STOCK')=='1':
 stock=sample('base',0,'stock')
 (results/'stock-summary.json').write_text(json.dumps({'topologyRejection':False,'modules':stock['records'][0]['modules']},indent=2)+'\n')
pairs=[]
for i in range(11):
 order=labels if i%2 else list(reversed(labels))
 data={label:sample(label,i) for label in order}
 parity(data['base'],data['pr']);parity(data['base'],data['calibration'])
 if i:pairs.append(data)
 else:(results/'parity-controls.json').write_text(json.dumps(control(data['base']),indent=2)+'\n')
summary={'pairs':10,'parity':True,'memoryIncrease':False,'metrics':{}}
comparisons=[('base-pr','base','pr'),('AA','base','calibration')]
for phase in ('cold','rebuild','revert'):
 def row(label,pair):return next(r for r in pair[label]['records'] if r['phase']==phase)
 for metric in ('wallMs','cpuMs','emitMs','buildGraphMs','rebuildGraphMs','splitChunksMs','peakBytes','steadyBytes'):
  factor=2**20 if metric.endswith('Bytes') else 1
  key=phase+'/'+metric.replace('Bytes','MiB')
  summary['metrics'][key]={name:summarize([row(a,p)[metric]/factor for p in pairs],[row(b,p)[metric]/factor for p in pairs]) for name,a,b in comparisons}
  if metric.endswith('Bytes') and summary['metrics'][key]['base-pr']['increase']:summary['memoryIncrease']=True
summary['metrics']['wholePeakMiB']={name:summarize([p[a]['processPeakBytes']/2**20 for p in pairs],[p[b]['processPeakBytes']/2**20 for p in pairs]) for name,a,b in comparisons}
summary['memoryIncrease']|=summary['metrics']['wholePeakMiB']['base-pr']['increase']
(results/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print('FINISHED memoryIncrease',summary['memoryIncrease'],flush=True)
