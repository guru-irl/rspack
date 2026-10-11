import json,sys,math,statistics
from pathlib import Path
from fractions import Fraction
root=Path(sys.argv[1])
output=Path(sys.argv[2])
def wilcoxon(values,shift=0):
    ds=[v-shift for v in values if abs(v-shift)>1e-9]
    if not ds:return 1.0
    order=sorted(range(len(ds)),key=lambda i:abs(ds[i]))
    ranks=[0]*len(ds);i=0
    while i<len(order):
        j=i+1
        while j<len(order) and abs(abs(ds[order[i]])-abs(ds[order[j]]))<1e-9:j+=1
        for k in range(i,j):ranks[order[k]]=i+1+j
        i=j
    observed=sum(r for d,r in zip(ds,ranks) if d>0)
    counts={0:1}
    for rank in ranks:
        nxt=counts.copy()
        for total,count in counts.items():nxt[total+rank]=nxt.get(total+rank,0)+count
        counts=nxt
    total=sum(ranks)
    tail=sum(count for s,count in counts.items() if s<=min(observed,total-observed))
    return min(1,2*tail/(2**len(ds)))
def interval(values):
    walsh=sorted((a+b)/2 for i,a in enumerate(values) for b in values[i:])
    hl=statistics.median(walsh)
    # Exact conditional signed-rank test inversion; ranks are recomputed for every shift.
    boundaries=sorted(set(walsh))
    accepted=[]
    scale=max(1,max(abs(v) for v in values))
    points=[boundaries[0]-scale]+[(a+b)/2 for a,b in zip(boundaries,boundaries[1:])]+[boundaries[-1]+scale]
    bounds=[-math.inf]+boundaries+[math.inf]
    for i,x in enumerate(points):
        if wilcoxon(values,x)>0.05:accepted.extend([bounds[i],bounds[i+1]])
    for x in boundaries:
        if wilcoxon(values,x)>0.05:accepted.append(x)
    return {'hl':hl,'low':min(accepted),'high':max(accepted),'pExact':wilcoxon(values),'n':len(values)}

def read(arm,index,scenario):
    directory=root/f'{scenario}-{index}-{arm}'
    assert json.loads((directory/'exit.json').read_text())['status']==0,(directory,'failed command')
    assert json.loads((directory/'success.json').read_text())['passed']
    checks=json.loads((directory/'checks.json').read_text()); events=json.loads((directory/'events.json').read_text())
    samples=json.loads((directory/'rss.json').read_text()); builds=json.loads((directory/'builds.json').read_text())
    assert all(not b['errors'] for b in builds),(directory,'failed compilation')
    def memory(es):
        start=min(e['wallMs'] for e in es if e['kind']=='watchRun'); end=max(e['wallMs'] for e in es if e['kind']=='done')
        during=[s for s in samples if start<=s['wallMs']<=end and 'VmRSS' in s]
        assert during,'external RSS samples exist'
        post=min((s for s in samples if 'VmRSS' in s),key=lambda s:abs(s['wallMs']-(end+750)))
        return {'peakMiB':max(s['VmRSS'] for s in during)/2**20,'postMiB':post['VmRSS']/2**20,'hwmMiB':post['VmHWM']/2**20}
    if scenario=='cold-measure':
        cold=json.loads((directory/'cold.json').read_text())
        return {**cold,**memory([e for e in events if e['step']=='initial']), 'peakMiB':max(s['VmRSS'] for s in samples if 'VmRSS' in s)/2**20,'hwmMiB':max(s['VmHWM'] for s in samples if 'VmHWM' in s)/2**20, 'ssrPasses':len([b for b in builds if b['name']=='ssr']), 'clientPasses':len([b for b in builds if b['name']=='client'])}
    warm=[]
    for c in checks:
        if not c['step'].startswith(('leaf-','body-')):continue
        es=[e for e in events if e['step']==c['step']]
        warm.append({**c['timing'],**memory(es),'ssrPasses':len([b for b in builds if b['step']==c['step'] and b['name']=='ssr'])})
    assert len(warm)==10,(directory,len(warm))
    return {metric:statistics.median([w[metric] for w in warm]) for metric in ['spanMs','clientMs','ssrMs','ssrPasses','peakMiB','postMiB','hwmMiB']}
orders=json.loads((root/'arm-orders.json').read_text())
for scenario in ['cold-measure','warm-leaf','warm-body']:
    relevant=[o for o in orders if o['scenario']==scenario]
    assert len(relevant)==10
    assert sum(o['arms'][0]=='stock' for o in relevant)==5,'exact 5/5 balance'
result={'method':'10 fresh-process paired groups per scenario, exactly 5 forward and 5 reverse. Warm process medians of 10 edits. Reduced-load measurement harness has no module taps, asset hashing, originalSource capture or stats.toJson. RSS and VmHWM sampled externally every 10 ms. Exact two-sided Wilcoxon sign enumeration and conservative 95% inversion intervals with HL Walsh medians. Descriptive, unadjusted comparisons.','orders':orders,'samples':{},'comparisons':[]}
for scenario in ['cold-measure','warm-leaf','warm-body']:
    arms=['stock','gate-only','barrier','after-make'] if scenario=='cold-measure' else ['stock','gate-only','barrier']
    data={arm:[read(arm,i,scenario) for i in range(1,11)] for arm in arms};result['samples'][scenario]=data
    metrics=['ssrReadyMs','finalReadyMs','peakMiB','hwmMiB','ssrPasses','clientPasses'] if scenario=='cold-measure' else ['spanMs','clientMs','ssrMs','ssrPasses','peakMiB','postMiB','hwmMiB']
    pairs=[('stock',a) for a in arms[1:]]+[('gate-only','barrier')]
    for a,b in pairs:
        for metric in metrics:
            before=[v[metric] for v in data[a]];after=[v[metric] for v in data[b]];deltas=[y-x for x,y in zip(before,after)]
            result['comparisons'].append({'scenario':scenario,'before':a,'after':b,'metric':metric,'beforeMedian':statistics.median(before),'afterMedian':statistics.median(after),**interval(deltas),'deltas':deltas})
output.write_text(json.dumps(result,indent=2))
print(result['method'])
for r in result['comparisons']:
    print(r['scenario'],r['before'],'->',r['after'],r['metric'],*[round(r[k],3) for k in ['beforeMedian','afterMedian','hl','low','high','pExact']])
