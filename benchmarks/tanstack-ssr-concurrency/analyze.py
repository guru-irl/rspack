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
def read(arm,index):
    directory=root/f'warm-{index}-{arm}'
    assert json.loads((directory/'exit.json').read_text())['status']==0,(directory,'failed sample')
    assert json.loads((directory/'success.json').read_text())['passed']
    checks=json.loads((directory/'checks.json').read_text())
    events=json.loads((directory/'events.json').read_text())
    samples=json.loads((directory/'rss.json').read_text())
    cold=json.loads((directory/'cold.json').read_text())
    builds=json.loads((directory/'builds.json').read_text())
    assert all(not b['errors'] for b in builds),'failed compilation is not a sample'
    warm=[]
    for c in checks:
        if not c['step'].startswith('leaf-'):continue
        es=[e for e in events if e['step']==c['step']]
        start=min(e['wallMs'] for e in es if e['kind']=='watchRun')
        end=max(e['wallMs'] for e in es if e['kind']=='done')
        during=[s['VmRSS'] for s in samples if start<=s['wallMs']<=end and 'VmRSS' in s]
        assert during,'warm RSS samples exist'
        post=min((s for s in samples if 'VmRSS' in s),key=lambda s:abs(s['wallMs']-(end+750)))['VmRSS']
        warm.append({**c['timing'],'peakMiB':max(during)/2**20,'postMiB':post/2**20})
    assert len(warm)>=10
    initialEnd=max(e['wallMs'] for e in events if e['step']=='initial' and e['kind']=='done')
    cold['peakMiB']=max(s['VmRSS'] for s in samples if s['wallMs']<=initialEnd+750 and 'VmRSS' in s)/2**20
    for env in ['client','ssr']:
        es=[e for e in events if e['step']=='initial' and e['name']==env]
        for begin,end,label in [('make','finishMake','MakeMs'),('seal','afterSeal','SealMs')]:
            starts=[e['t'] for e in es if e['kind']==begin];ends=[e['t'] for e in es if e['kind']==end]
            assert len(starts)==len(ends)
            cold[env+label]=sum(b-a for a,b in zip(starts,ends))
    return {'warm':{m:statistics.median([w[m] for w in warm]) for m in ['spanMs','clientMs','ssrMs','peakMiB','postMiB']},'cold':cold}
data={arm:[read(arm,i) for i in range(10)] for arm in ['stock','barrier','after-make','overlap']}
result={'method':'10 independent process triplets, 10 edits per process; warm process-median pairs. Exact two-sided Wilcoxon sign enumeration with averaged tie ranks and omitted zeros; 95% inversion interval; HL median Walsh averages.','comparisons':[]}
for mode,metrics in [('warm',['spanMs','clientMs','ssrMs','peakMiB','postMiB']),('cold',['ssrReadyMs','finalReadyMs','peakMiB','clientMakeMs','clientSealMs','ssrMakeMs','ssrSealMs'])]:
    for a,b in [('stock','barrier'),('stock','after-make'),('stock','overlap'),('barrier','after-make'),('barrier','overlap'),('after-make','overlap')]:
        for metric in metrics:
            before=[v[mode][metric] for v in data[a]];after=[v[mode][metric] for v in data[b]]
            deltas=[y-x for x,y in zip(before,after)]
            result['comparisons'].append({'mode':mode,'before':a,'after':b,'metric':metric,'beforeMedian':statistics.median(before),'afterMedian':statistics.median(after),**interval(deltas),'deltas':deltas})
output.write_text(json.dumps(result,indent=2))
print(result['method'])
for r in result['comparisons']:
    print(r['mode'],r['before'],'->',r['after'],r['metric'],*[round(r[k],3) for k in ['beforeMedian','afterMedian','hl','low','high']],r['pExact'])
