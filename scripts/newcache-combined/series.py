import json, os, shutil, subprocess, sys, time
from pathlib import Path
from sample import measure
H=Path(__file__).resolve().parent
config=json.loads(Path(sys.argv[1]).read_text())
w=Path(os.environ['HARNESS_WORK']);r=Path(os.environ['HARNESS_RESULTS']);r.mkdir(parents=True,exist_ok=True)
p=w/'project';seeds=w/'seeds';seeds.mkdir(exist_ok=True)
cores=json.loads((w/'cores.json').read_text()); expected=None
host=[]; rows=[]
def run(a,phase,label,seed=False,count=False):
 env=dict(os.environ,ARM=a,PROJECT=str(p),RSPACK_CORE=cores['B' if a=='C' else 'A'],SOURCE_SHA=config['arms']['B' if a=='C' else 'A'],PARENT_SAMPLER='0' if seed else '1',SEED_ONLY='1' if seed else '0',COUNT='1' if count else '0',RSPACK_ROUTE_COUNTERS='1')
 if a=='C':env['RSPACK_PROBE_GRAPH']='1'
 else:env.pop('RSPACK_PROBE_GRAPH',None)
 info=dict(label=label,time=time.time(),cpu_count=os.cpu_count())
 if hasattr(os,'getloadavg'):info['load']=os.getloadavg()
 host.append(info);(r/'host.json').write_text(json.dumps(host))
 out=r/(label+'.json');cmd=['node','--expose-gc',str(H/'run.mjs'),phase,str(out)]
 if seed:
  with out.with_suffix('.log').open('w') as log:subprocess.run(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=300)
  data=json.loads(out.read_text())
 else:data=measure(cmd,out,env)
 log=out.with_suffix('.log').read_text()
 if a=='C' and phase=='warm':assert 'Benchmark bulk graph recovered' in log,(label,'fallback')
 for line in log.splitlines():
  if line.startswith('ROUTE_D_COUNTERS '):
   gc={k:int(v) for k,v in (item.split('=') for item in line.split()[1:])}
   data['native_counts']=gc
   if config['modules']==60000:assert (gc['modules'],gc['dependencies'],gc['connections'])==(72061,552227,492067),(label,gc)
   if phase=='warm':assert gc['builds']==0,(label,gc)
 out.write_text(json.dumps(data))
 if expected is not None:assert data['outputs']==expected,(label,'output mismatch')
 if seed or count:
  gc=data['graph_counts'];n=config['modules'];assert gc['modules']==n+n//5+61,(label,gc)
  if n==60000:assert gc==dict(modules=72061,dependencies=552227,connections=492067,incoming=492067),(label,gc)
 return data
if '--prepare' in sys.argv:
 subprocess.run(['node',str(H/'gen.mjs'),str(config['modules'])],env=dict(os.environ,PROJECT=str(p)),check=True)
 for a in ['C','L','N']:
  for d in [p/'cache',p/'dist']:
   if d.exists():shutil.rmtree(d)
  data=run(a,'cold','seed-'+a,seed=True)
  if expected is None:expected=data['outputs']
  shutil.copytree(p/'cache',seeds/a,copy_function=shutil.copy2)
  # Warm graph cardinality is checked outside gates.
  run(a,'warm','count-'+a,seed=True,count=True)
 (w/'reference.json').write_text(json.dumps(expected))
 sys.exit(0)
expected=json.loads((w/'reference.json').read_text())
for phase in ['warm','cold']:
 for i in range(config['pairs']):
  kinds=['LC','NC','CC','LL','NN'];kinds=kinds[i%5:]+kinds[:i%5]
  for kind in kinds:
   observed={}; order=[0,1] if i%2==0 else [1,0]
   for slot in order:
    a=kind[slot]
    for d in [p/'cache',p/'dist']:
     if d.exists():shutil.rmtree(d)
    if phase=='warm':shutil.copytree(seeds/a,p/'cache',copy_function=shutil.copy2)
    # Warm both runtimes, fixture and seed symmetrically.
    for root in [p,Path(cores['A']).parents[2],Path(cores['B']).parents[2]]:
     for f in root.rglob('*'):
      if f.is_file() and 'node_modules' not in f.parts:
       with f.open('rb') as stream:
        while stream.read(1024*1024):pass
    observed[slot]=run(a,phase,f'{"direct-" if os.environ.get("CLOSE_DIRECT")=="1" else ""}{phase}-{kind}-{i}-{slot}-{a}')
   rows.append(dict(phase=phase,kind=kind,pair=i,order=order,baseline=observed[0],candidate=observed[1]))
   (r/('direct-pairs.json' if os.environ.get('CLOSE_DIRECT')=='1' else 'pairs.json')).write_text(json.dumps(rows))
print('Completed',len(rows),'paired observations with byte-identical output')
