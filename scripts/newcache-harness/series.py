import csv
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import time
from sample import measure

HERE = Path(__file__).resolve().parent
config = json.loads(Path(sys.argv[1]).read_text())
mode = sys.argv[2] if len(sys.argv)>2 else 'all'
if mode not in ['all','prepare','measure']: raise ValueError('Expected all, prepare or measure')
work = Path(os.environ['HARNESS_WORK']).resolve()
results = Path(os.environ['HARNESS_RESULTS']).resolve()
results.mkdir(parents=True, exist_ok=True)
project = work/'project'
seeds = work/'seeds'
if mode != 'measure':
    if seeds.exists(): raise RuntimeError('Use a fresh work directory for independent seeds')
    seeds.mkdir(parents=True)
elif not (work/'seed-manifest.json').exists(): raise RuntimeError('Prepare closed seeds before requesting the measurement lock')
cores = {arm:Path(os.environ['CORE_'+arm]).resolve() for arm in ['A','B']}
for sha in config['arms'].values():
    if len(sha)!=40 or any(c not in '0123456789abcdef' for c in sha): raise ValueError('Full source SHA required')
records = []
host_samples = []
protocol=dict(shared_seed=config.get('shared_seed',True),post_done_gc=False,done_gc=False,completed_idle_gc=True,post_close_gc=True,actual_checkpoint_offsets=True,watch_post_done_source='external_timeline',post_done_ms=config.get('post_done_ms',[100,500]),idle_timeout_ms=config.get('idle_timeout_ms',3000),run_sha256=hashlib.sha256((HERE/'run.mjs').read_bytes()).hexdigest(),generator_sha256=hashlib.sha256((HERE/'gen.mjs').read_bytes()).hexdigest())
(results/'measurement-protocol.json').write_text(json.dumps(protocol,indent=2))

def run(arm, phase, name):
    info=dict(sample=name,at=time.time(),cpu_count=os.cpu_count())
    if hasattr(os,'getloadavg'):info['loadavg']=os.getloadavg()
    if sys.platform.startswith('linux'):
        info['meminfo']=Path('/proc/meminfo').read_text()
        available=int(next(l.split()[1] for l in info['meminfo'].splitlines() if l.startswith('MemAvailable:')))*1024
        if available < 8*1024**3:raise RuntimeError('Measurement needs >=8 GiB available RAM')
    host_samples.append(info)
    (results/'host-samples.json').write_text(json.dumps(host_samples))
    env = dict(os.environ, PROJECT=str(project), RSPACK_CORE=str(cores[arm]), SOURCE_SHA=config['arms'][arm], PARENT_SAMPLER='1', POST_DONE_MS=json.dumps(config.get('post_done_ms',[100,500])), IDLE_TIMEOUT_MS=str(config.get('idle_timeout_ms',3000)))
    return measure(['node','--expose-gc',str(HERE/'run.mjs'),phase,str(results/(name+'.json'))], results/(name+'.json'), env)

def seed_hash(root):
    rows=[]
    for p in sorted(root.rglob('*')):
        if p.is_file():
            rows.append(dict(path=p.relative_to(root).as_posix(),bytes=p.stat().st_size,mtime_ns=p.stat().st_mtime_ns,sha256=hashlib.sha256(p.read_bytes()).hexdigest()))
    return hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def preread():
    # Explicit warm page-cache start for sources, packages and the restored cache.
    for root in [project, cores['A'].parent, cores['B'].parent]:
        for file in root.rglob('*'):
            if file.is_file():
                with file.open('rb') as f:
                    while f.read(1024*1024): pass

def validate(result, reference):
    if result['outputs_by_round'][0] != reference: raise RuntimeError('Byte-identical initial output parity failed')
    names=['done']
    if result['phase'] != 'cold': names += [f'post_done_{n}ms' for n in config.get('post_done_ms',[100,500])]
    names += ['END']
    if result['phase']=='watch': names += ['rebuild_done','rebuild_END']
    names += ['post_close']
    if [a['name'] for a in result['anchors']] != names: raise RuntimeError('Missing anchors')
    if len(result['outputs_by_round']) != (2 if result['phase']=='watch' else 1): raise RuntimeError('Missing output round')
    for a in result['anchors']:
        expected = ['RssAnon','VmHWM'] if sys.platform.startswith('linux') else ['phys_footprint','peak_phys_footprint'] if sys.platform=='darwin' else ['private_bytes','peak_commit','working_set','peak_working_set']
        if any(k not in a['memory'] for k in expected): raise RuntimeError('Missing memory counter')

if mode != 'measure':
  subprocess.run(['node',str(HERE/'gen.mjs'),str(config['modules'])],env=dict(os.environ,PROJECT=str(project)),check=True)
  reference = None
  for arm in (['A'] if config.get('shared_seed',True) else ['A','B']):
    if (project/'dist').exists():shutil.rmtree(project/'dist')
    if (project/'cache').exists(): shutil.rmtree(project/'cache')
    result = run(arm,'cold','seed-'+arm)
    if reference is None: reference=result['outputs']
    validate(result,reference)
    shutil.copytree(project/'cache',seeds/arm,copy_function=shutil.copy2)
  if config.get('shared_seed',True):
    shutil.copytree(seeds/'A',seeds/'B',copy_function=shutil.copy2)
  hashes={arm:seed_hash(seeds/arm) for arm in ['A','B']}
  if config.get('shared_seed',True) and hashes['A']!=hashes['B']: raise RuntimeError('Shared seed copy differs')
  seed_manifest=dict(config=config,outputs=reference,seed_hashes=hashes)
  (work/'seed-manifest.json').write_text(json.dumps(seed_manifest,indent=2))
  if mode=='prepare':
    print('Prepared closed seeds; no paired measurement has run.')
    sys.exit(0)
else:
  seed_manifest=json.loads((work/'seed-manifest.json').read_text())
  if seed_manifest['config'] != config: raise RuntimeError('Prepared seed configuration mismatch')
  reference=seed_manifest['outputs']
  for arm in ['A','B']:
    if seed_hash(seeds/arm)!=seed_manifest['seed_hashes'][arm]: raise RuntimeError('Closed seed changed')
protocol.update(seed_hashes=seed_manifest['seed_hashes'])
(results/'measurement-protocol.json').write_text(json.dumps(protocol,indent=2))
leaf=project/'src/d0/m9.js'
original=leaf.read_bytes(); source_stat=leaf.stat()
phases=config.get('phases',['warm','watch'])
for phase in phases:
  for pair in range(max(config['aa_pairs'],config['pairs'])):
    for kind,n in [('AA',config['aa_pairs']),('AB',config['pairs'])]:
        if pair>=n: continue
        arms=['A','A'] if kind=='AA' else ['A','B']
        order=[0,1] if pair%2==0 else [1,0]
        observed={}
        for pos in order:
            arm=arms[pos]
            leaf.write_bytes(original);os.utime(leaf,ns=(source_stat.st_atime_ns,source_stat.st_mtime_ns))
            shutil.rmtree(project/'cache');shutil.copytree(seeds/arm,project/'cache',copy_function=shutil.copy2)
            preread()
            if (project/'dist').exists():shutil.rmtree(project/'dist')
            result=run(arm,phase,f'{phase}-{kind}-{pair}-{pos}-{arm}')
            validate(result,reference)
            observed[pos]=result
        if observed[0]['outputs_by_round'] != observed[1]['outputs_by_round']: raise RuntimeError('Per-round byte-identical paired parity failed')
        row=dict(phase=phase,kind=kind,pair=pair,order=order,baseline=observed[0],candidate=observed[1])
        records.append(row)
        (results/'pairs.json').write_text(json.dumps(records))
summary={}
for phase in phases:
  summary[phase]={}
  for kind in ['AA','AB']:
    rows=[r for r in records if r['kind']==kind and r['phase']==phase]
    metrics={}
    def add(metric,values):
      metrics[metric]=dict(median=statistics.median(values),worst=max(values),deltas=values)
    for name in [a['name'] for a in rows[0]['baseline']['anchors']]:
        def at(result): return next(a for a in result['anchors'] if a['name']==name)
        for field in ['wall_ms','cpu_ms'] if name=='done' else ['rebuild_ms','rebuild_cpu_ms'] if name=='rebuild_done' else []:
            add(name+'.'+field,[at(r['candidate'])[field]-at(r['baseline'])[field] for r in rows])
        for field in at(rows[0]['baseline'])['memory']:
            add(name+'.'+field,[at(r['candidate'])['memory'][field]-at(r['baseline'])['memory'][field] for r in rows])
    add('close_ms',[r['candidate']['close_ms']-r['baseline']['close_ms'] for r in rows])
    for peak in ['sampled_peak','rebuild_sampled_peak']:
      for field in rows[0]['baseline'].get(peak,{}):
        add(peak+'.'+field,[r['candidate'][peak][field]-r['baseline'][peak][field] for r in rows])
    summary[phase][kind]=metrics
increases=[];time_increases=[]
for phase in phases:
  for metric,value in summary[phase]['AB'].items():
    noise=max(0,max(abs(v) for v in summary[phase]['AA'][metric]['deltas']))
    if value['worst']>noise or value['median']>noise:
      row=dict(phase=phase,metric=metric,median=value['median'],worst=value['worst'],aa_max_abs=noise)
      (time_increases if metric.endswith('ms') else increases).append(row)
summary.update(memory_increases=increases,time_increases=time_increases,protocol=protocol,config=config,platform=platform.platform(),node=subprocess.check_output(['node','--version'],text=True).strip())
with (results/'paired-deltas.csv').open('w',newline='') as f:
    writer=csv.writer(f);writer.writerow(['phase','comparison','metric','pair','delta'])
    for phase in phases:
      for kind in ['AA','AB']:
        for metric,value in summary[phase][kind].items():
            for pair,delta in enumerate(value['deltas']):writer.writerow([phase,kind,metric,pair,delta])
(results/'summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
if increases: raise RuntimeError('Memory increase beyond A/A noise: stop')
