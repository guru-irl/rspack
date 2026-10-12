import json,sys,math
from pathlib import Path
root=Path(sys.argv[1])
def fisher(a,b,c,d):
    n=a+b+c+d;row=a+b;col=a+c
    if not n:return 1.0
    def weight(x):return math.comb(col,x)*math.comb(n-col,row-x)
    observed=weight(a)
    return sum(weight(x) for x in range(max(0,row-(n-col)),min(row,col)+1) if weight(x)<=observed)/math.comb(n,row)
records=[]
for file in sorted(root.glob('*/replay-summary.json')):
    directory=file.parent
    assert json.loads((directory/'exit.json').read_text())['status']==0,('failed run is never a sample',directory)
    success=json.loads((directory/'success.json').read_text());assert success['passed']
    for c in json.loads(file.read_text())['checkpoints']:
        records.append({'process':directory.name,'arm':success['arm'],'scenario':success['scenario'],**c})
def aggregate(rows):
    return {'checkpoints':len(rows),'passes':sum(c['passes'] for c in rows),'nonReplayPasses':sum(c['nonReplay'] for c in rows),'replayPasses':sum(c['replays'] for c in rows),'checkpointsWithReplay':sum(c['replays']>0 for c in rows),'multiPassCheckpoints':sum(c['passes']>1 for c in rows),'passesPerCheckpoint':sum(c['passes'] for c in rows)/len(rows) if rows else None}
groups=[]
for scenario in sorted(set(r['scenario'] for r in records)):
    for compiler in sorted(set(r['name'] for r in records)):
        # Startup is reported separately, never mislabeled as an edit.
        for phase in ['startup','edit']:
            rows=[r for r in records if r['scenario']==scenario and r['name']==compiler and (r['step']=='initial')==(phase=='startup')]
            if not rows:continue
            arms={arm:aggregate([r for r in rows if r['arm']==arm]) for arm in sorted(set(r['arm'] for r in rows))}
            comparisons={}
            if 'stock' in arms and 'barrier' in arms:
                a=arms['stock'];b=arms['barrier']
                for label,key in [('replayFrequency','checkpointsWithReplay'),('clientPassesPerEdit','multiPassCheckpoints')]:
                    if label=='clientPassesPerEdit' and compiler!='client':continue
                    comparisons[label]={'table':[[a[key],a['checkpoints']-a[key]],[b[key],b['checkpoints']-b[key]]],'fisherExactTwoSided':fisher(a[key],a['checkpoints']-a[key],b[key],b['checkpoints']-b[key])}
            groups.append({'scenario':scenario,'compiler':compiler,'phase':phase,'arms':arms,'defaultVsStock':comparisons})
result={'method':'Actual validated (a)-(c) replay passes, retained in spans. Fisher two-sided on checkpoints with >=1 replay versus none. Client-pass Fisher uses checkpoints with >1 total pass versus <=1, not a surrogate replay classification. Correctness and measurements are separate. Repeated edits within processes are descriptive, not independent process-level timing inference.','groups':groups,'records':records}
(root/'replay-frequency.json').write_text(json.dumps(result,indent=2))
for g in groups:print(json.dumps(g))
