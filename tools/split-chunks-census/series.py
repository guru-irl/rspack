import os, sys, subprocess, json, pathlib, hashlib, statistics, shutil
repo=pathlib.Path.cwd()
root=repo/'.spider/scratch/sc-census'
root.mkdir(parents=True,exist_ok=True)
results=root/'results';results.mkdir(exist_ok=True)
binding=next((repo/'crates/node_binding').glob('rspack.*.node'))
instrument=root/'instrument.node'
baseline=root/'baseline.node'
assert instrument.exists() and baseline.exists()

def invoke(arm,label,on=False,controlled=False,affinity=None):
    env=os.environ.copy();env.pop('RSPACK_SC_CENSUS',None)
    env.pop('RSPACK_RAYON_STATS',None);env.pop('RSPACK_RAYON_MARKS',None)
    env['SC_FIXTURE_ROOT']=str(root/('priority' if arm.startswith('priority') else arm))
    env['SC_ARM']=arm;env['SC_RSPACK']=str(repo/'packages/rspack')
    result=results/f'{arm}-{label}.json'
    census=results/f'{arm}-{label}.jsonl'
    env['SC_RESULT']=str(result)
    if on:env['RSPACK_SC_CENSUS']=str(census)
    env['RSPACK_SC_CENSUS_MODE']='controlled' if controlled else 'natural'
    shutil.copyfile(instrument if (on or label=='instrument-off') else baseline,binding)
    if arm.startswith('priority'):
        command=['node','tools/split-chunks-census/priority-run.mjs','--rspack',env['SC_RSPACK'],'--arm',arm.split('-')[1],'--out',str(result)]
    else:command=['node','tools/split-chunks-census/many-run.mjs']
    if affinity:command=['taskset','-c',affinity]+command
    with open(results/f'{arm}-{label}.log','w') as log:
        subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=2400)
    return json.loads(result.read_text()),census

def qualify(arm,result,census):
    rows=[json.loads(s) for s in census.read_text().splitlines()]
    errors=[];detail=[]
    for pass_id in sorted({r['pass'] for r in rows}):
        structures=[r['row'] for r in rows if r['pass']==pass_id and r['row']['kind']=='structure']
        inv=next(r['values'] for r in structures if r['site']=='invocation')
        totals=[r['values'] for r in structures if r['site']=='priority_totals']
        boundaries=[r['values'] for r in structures if r['site']=='reuse_boundary']
        initial=[r['values']['G'] for r in structures if r['site']=='initial_groups']
        shapes=[r['values'] for r in structures if r['site']=='cleanup_shape']
        wins=[t['W'] for t in totals]
        hits=sum(b['predicted_hit'] for b in boundaries)
        d={'pass':pass_id,**inv,'W':sum(wins),'A':sum(t['A'] for t in totals),'wins':wins,'G':initial,'r':hits,'B':len(boundaries)-hits,'dirty':sum(b['actual_deletions']>0 for b in boundaries),'named_W':sum(t['named_W'] for t in totals)}
        if arm.startswith('priority'):
            if inv['M']!=60064 or inv['P']!=49 or hits!=48 or any(wins[:-1]) or d['B']!=1:errors.append(f'priority path missing {d}')
        else:
            if inv['C']<5001:errors.append('fewer than 5000 original routes')
            if inv['P']!=10 or d['W']<2000:errors.append('P/W target missing')
            if sum(g>=10000 for g in initial)<2:errors.append('two G>=10000 stages missing')
            if inv['cache_groups']<120:errors.append('120 groups missing')
            if sum(w>=200 for w in wins[:-1])<3:errors.append('three nonfinal W>=200 missing')
            if not d['named_W'] or not (d['W']-d['named_W']):errors.append('named/shared winners missing')
            positive=[s['mask_positive']/s['G'] for s in shapes if s['G']]
            if arm=='mixed-selective' and sum(v<=.25 for v in positive)<=len(positive)/2:errors.append('selective mask target missing')
            if arm=='mixed-saturated' and sum(v>=.9 for v in positive)<=len(positive)/2:errors.append('saturated mask target missing')
            if arm.startswith('mixed') and (hits==0 or d['dirty']<3):errors.append('mixed reuse/dirty targets missing')
            if arm=='every-priority-winner' and (hits!=0 or any(w<100 for w in wins[:-1]) or d['dirty']!=9):errors.append('every-priority target missing')
            d['mask_positive_median']=statistics.median(positive) if positive else None
        detail.append(d)
    if not arm.startswith('priority') and any(r['routeCount']<5000 for r in result['records']):errors.append('emitted named route diagnostic missing')
    return {'qualified':not errors,'errors':errors,'detail':detail}

arms=['priority-native','priority-callback','mixed-selective','mixed-saturated','every-priority-winner']
qualified=[]
for arm in arms:
    fixture=root/('priority' if arm.startswith('priority') else arm)
    if not fixture.exists():
        fixture.mkdir();env=os.environ.copy();env.update(SC_FIXTURE_ROOT=str(fixture),SC_ARM=arm)
        subprocess.run(['node','tools/split-chunks-census/'+('priority-gen.mjs' if arm.startswith('priority') else 'many-gen.mjs')],env=env,check=True)
    result,census=invoke(arm,'qualification',True,True)
    q=qualify(arm,result,census)
    (results/f'{arm}-qualification-summary.json').write_text(json.dumps(q,indent=2))
    print(arm,'qualification',q['qualified'],q['errors'],flush=True)
    if not q['qualified']:continue
    reference,_=invoke(arm,'baseline-parity')
    disabled,_=invoke(arm,'instrument-off')
    def manifests(r):return [b['hashes'] for b in r['records']]
    assert manifests(reference)==manifests(disabled)==manifests(result), 'baseline/instrument-off/instrument-on output differs'
    if arm.startswith('priority'): assert [r['callbacks'] for r in reference['records']]==[r['callbacks'] for r in disabled['records']]==[r['callbacks'] for r in result['records']]
    (results/f'{arm}-parity.json').write_text(json.dumps({'baseline_disabled_enabled_equal':True}))
    hashes={str(f.relative_to(fixture)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((fixture/'src').rglob('*')) if f.is_file()}
    (results/f'{arm}-fixture-hashes.json').write_text(json.dumps(hashes,sort_keys=True))
    qualified.append(arm)
# Qualification failures are never samples. Qualified arms may finish their
# bounded series while the failed public generator arm is explicitly blocked.
for arm in qualified:
    for allocation in ['normal']+(['three-core'] if sys.platform=='linux' else []):
        cpus=sorted(os.sched_getaffinity(0)) if sys.platform=='linux' else []
        affinity=','.join(map(str,cpus[:3])) if allocation=='three-core' else None
        if allocation=='three-core' and len(cpus)<3:raise RuntimeError('no real three-core allocation')
        for pair in range(5):
            for on in ([False,True] if pair%2==0 else [True,False]):
                invoke(arm,f'{allocation}-pair{pair}-'+('on' if on else 'off'),on,False,affinity)
    for run in range(3):invoke(arm,f'controlled{run}',True,True)
(results/'series-status.json').write_text(json.dumps({'qualified':qualified,'failed':[a for a in arms if a not in qualified]}))
if len(qualified)!=len(arms):sys.exit(2)
