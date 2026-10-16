import json, pathlib, statistics, itertools
root = pathlib.Path(__file__).resolve().parent
D = root / 'data'
meta = json.loads((D/'metadata.json').read_text())
assert json.loads((D/'run-complete.json').read_text())['blocks'] == 10
schedule = [json.loads(x) for x in (D/'schedule.jsonl').read_text().splitlines()]
median = statistics.median

def interval(d):
    assert len(d) == 10
    walsh = sorted((d[i]+d[j])/2 for i in range(10) for j in range(i,10))
    tail = sum(sum((i+1)*bit for i,bit in enumerate(bits)) <= 8 for bits in itertools.product([0,1],repeat=10))
    assert tail == 25
    return {'hl':median(walsh),'lower':walsh[8],'upper':walsh[46],'coverage':1-2*tail/1024,'increased':walsh[8]>0,'differences':d}

def load(s):
    rows=[json.loads(x) for x in (D/s['tag']/'results.jsonl').read_text().splitlines()]
    assert rows[0]['scenario']=='initial'
    edits=[r for r in rows if r['scenario'].startswith('content-')]
    assert len(edits)==5
    assert all(r['nativeSha256']==meta['hashes'][s['arm']] for r in rows)
    assert all(r['changedExisting']==0 for r in rows)
    result={'contentMs':median(r['elapsedMs'] for r in edits),'steadyMiB':edits[-1]['steadyRssBytes']/2**20,'peakMiB':s['receipt']['peakRssBytes']/2**20,'codeGenerated':median(r['codeGenerated'] for r in edits),'coldHash':rows[0]['outputHash']}
    for scenario in ['add10','add1000']:
        found=[r for r in rows if r['scenario']==scenario]
        if found: result[scenario+'Ms']=found[0]['elapsedMs']
    return result
samples=[dict(s,metrics=load(s)) for s in schedule]
assert len(set(s['metrics']['coldHash'] for s in samples)) == 1, 'Cold output mismatch'
paired=[s for s in samples if s['block']>0]
linux=meta['platform']=='linux'
assert len(paired)==(40 if linux else 20)
metrics=['contentMs','peakMiB','steadyMiB']+(['add10Ms','add1000Ms'] if linux else [])
result={'metadata':meta,'coldOutputIdentical':True,'samples':samples,'metrics':{},'aa':{}}
for key in metrics:
    values={arm:[s['metrics'][key] for s in paired if s['arm']==arm] for arm in ['base','pr']}
    medians={a:median(v) for a,v in values.items()}
    deltas=[]
    for block in range(1,11):
        v={a:[s['metrics'][key] for s in paired if s['block']==block and s['arm']==a] for a in ['base','pr']}
        deltas.append(statistics.mean(v['pr'])-statistics.mean(v['base']))
    result['metrics'][key]={'base':medians['base'],'pr':medians['pr'],'percent':100*(medians['pr']/medians['base']-1),'pairedMedian':median(deltas),**interval(deltas)}
    if linux:
        result['aa'][key]={}
        for arm in ['base','pr']:
            diffs=[]
            for block in range(1,11):
                v={s['family']:s['metrics'][key] for s in paired if s['block']==block}
                diffs.append(v[arm+'2']-v[arm+'1'])
            result['aa'][key][arm]={'median':median(diffs),'minimum':min(diffs),'maximum':max(diffs),'medianAbsolute':median(map(abs,diffs)),'maxAbsolute':max(map(abs,diffs)),'differences':diffs}
(D/'summary.json').write_text(json.dumps(result,indent=2))
lines=['# Hosted evidence summary',f"Platform: {meta['platform']} / {meta['arch']}",'Exact intervals: paired Walsh order statistics 9 and 47, 95.1171875% attainable coverage.','', '| Metric | Base median | PR median | Change | Paired median delta | HL delta | Exact 95% interval | Increased |','| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |']
for key,m in result['metrics'].items():
    lines.append(f"| {key} | {m['base']:.4f} | {m['pr']:.4f} | {m['percent']:+.2f}% | {m['pairedMedian']:+.4f} | {m['hl']:+.4f} | [{m['lower']:+.4f}, {m['upper']:+.4f}] | {m['increased']} |")
if linux:
    lines+=['','| Metric | A/A build | Median signed delta | Signed range | Median absolute delta | Maximum absolute delta |','| --- | --- | ---: | --- | ---: | ---: |']
    for key,arms in result['aa'].items():
        for arm,a in arms.items():
            lines.append(f"| {key} | {arm} | {a['median']:+.4f} | [{a['minimum']:+.4f}, {a['maximum']:+.4f}] | {a['medianAbsolute']:.4f} | {a['maxAbsolute']:.4f} |")
lines+=['','Cold output SHA-256 parity: PASS.','Content codegen processed medians: '+str({a:median(s['metrics']['codeGenerated'] for s in paired if s['arm']==a) for a in ['base','pr']})]
(D/'summary.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines))
