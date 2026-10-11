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
work = Path(os.environ['HARNESS_WORK']).resolve()
results = Path(os.environ['HARNESS_RESULTS']).resolve()
results.mkdir(parents=True, exist_ok=True)
project = work/'project'
seeds = work/'seeds'
if seeds.exists(): raise RuntimeError('Use a fresh work directory for independent seeds')
seeds.mkdir(parents=True)
cores = {arm:Path(os.environ['CORE_'+arm]).resolve() for arm in ['A','B']}
for sha in config['arms'].values():
    if len(sha)!=40 or any(c not in '0123456789abcdef' for c in sha): raise ValueError('Full source SHA required')
records = []

def run(arm, phase, name):
    env = dict(os.environ, PROJECT=str(project), RSPACK_CORE=str(cores[arm]), SOURCE_SHA=config['arms'][arm], PARENT_SAMPLER='1')
    return measure(['node','--expose-gc',str(HERE/'run.mjs'),phase,str(results/(name+'.json'))], results/(name+'.json'), env)

def preread():
    # Explicit warm page-cache start for sources, packages and the restored cache.
    for root in [project, cores['A'].parent, cores['B'].parent]:
        for file in root.rglob('*'):
            if file.is_file():
                with file.open('rb') as f:
                    while f.read(1024*1024): pass

def validate(result, reference):
    if result['outputs'] != reference: raise RuntimeError('Byte-identical output parity failed')
    if [a['name'] for a in result['anchors']] != ['done','END','post_close']: raise RuntimeError('Missing anchors')
    for a in result['anchors']:
        expected = ['RssAnon','VmHWM'] if sys.platform.startswith('linux') else ['phys_footprint','peak_phys_footprint'] if sys.platform=='darwin' else ['private_bytes','peak_commit','working_set','peak_working_set']
        if any(k not in a['memory'] for k in expected): raise RuntimeError('Missing memory counter')

subprocess.run(['node',str(HERE/'gen.mjs'),str(config['modules'])],env=dict(os.environ,PROJECT=str(project)),check=True)
reference = None
for arm in ['A','B']:
    if (project/'cache').exists(): shutil.rmtree(project/'cache')
    result = run(arm,'cold','seed-'+arm)
    if reference is None: reference=result['outputs']
    validate(result,reference)
    shutil.copytree(project/'cache',seeds/arm,copy_function=shutil.copy2)

for kind,n in [('AA',config['aa_pairs']),('AB',config['pairs'])]:
    for pair in range(n):
        arms=['A','A'] if kind=='AA' else ['A','B']
        order=[0,1] if pair%2==0 else [1,0]
        observed={}
        for pos in order:
            arm=arms[pos]
            shutil.rmtree(project/'cache');shutil.copytree(seeds/arm,project/'cache',copy_function=shutil.copy2)
            preread()
            result=run(arm,'warm',f'{kind}-{pair}-{pos}-{arm}')
            validate(result,reference)
            observed[pos]=result
        row=dict(kind=kind,pair=pair,order=order,baseline=observed[0],candidate=observed[1])
        records.append(row)
        (results/'pairs.json').write_text(json.dumps(records))

summary={}
for kind in ['AA','AB']:
    rows=[r for r in records if r['kind']==kind]
    metrics={}
    for name in ['done','END','post_close']:
        for field in ['wall_ms','cpu_ms'] if name=='done' else []:
            vals=[r['candidate']['anchors'][0][field]-r['baseline']['anchors'][0][field] for r in rows]
            metrics[name+'.'+field]=dict(median=statistics.median(vals),worst=max(vals),deltas=vals)
        base=next(a for a in rows[0]['baseline']['anchors'] if a['name']==name)
        for field in base['memory']:
            vals=[next(a for a in r['candidate']['anchors'] if a['name']==name)['memory'][field]-next(a for a in r['baseline']['anchors'] if a['name']==name)['memory'][field] for r in rows]
            metrics[name+'.'+field]=dict(median=statistics.median(vals),worst=max(vals),deltas=vals)
    for field in rows[0]['baseline'].get('sampled_peak',{}):
        vals=[r['candidate']['sampled_peak'][field]-r['baseline']['sampled_peak'][field] for r in rows]
        metrics['sampled_peak.'+field]=dict(median=statistics.median(vals),worst=max(vals),deltas=vals)
    summary[kind]=metrics
increases=[]
for metric,value in summary['AB'].items():
    if metric.endswith(('wall_ms','cpu_ms')):continue
    noise=max(0,max(abs(v) for v in summary['AA'][metric]['deltas']))
    if value['worst']>noise:increases.append(dict(metric=metric,worst=value['worst'],aa_max_abs=noise))
summary.update(memory_increases=increases,config=config,platform=platform.platform(),node=subprocess.check_output(['node','--version'],text=True).strip())
with (results/'paired-deltas.csv').open('w',newline='') as f:
    writer=csv.writer(f);writer.writerow(['comparison','metric','pair','delta'])
    for kind in ['AA','AB']:
        for metric,value in summary[kind].items():
            for pair,delta in enumerate(value['deltas']):writer.writerow([kind,metric,pair,delta])
(results/'summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
if increases: raise RuntimeError('Memory increase beyond A/A noise: stop')
