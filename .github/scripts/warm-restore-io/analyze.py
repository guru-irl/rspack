import json, math, random, statistics, sys
from itertools import combinations_with_replacement
from collections import defaultdict

# Exact conditional signed-rank distribution, doubled midranks for ties, zeros omitted.
def signed_p(data):
    data = [x for x in data if x != 0]
    if not data: return 1.0
    order = sorted(range(len(data)), key=lambda i: abs(data[i]))
    ranks = [0] * len(data)
    i = 0
    while i < len(order):
        j = i + 1
        while j < len(order) and abs(data[order[j]]) == abs(data[order[i]]): j += 1
        for k in range(i,j): ranks[order[k]] = (i+1)+j
        i = j
    dist = {0: 1}
    for rank in ranks:
        nxt = defaultdict(int)
        for score,count in dist.items(): nxt[score] += count; nxt[score+rank] += count
        dist = nxt
    positive = sum(rank for rank,x in zip(ranks,data) if x > 0)
    score = min(positive, sum(ranks)-positive)
    return min(1.0, 2*sum(count for s,count in dist.items() if s <= score)/2**len(data))

def exact_hl(data):
    walsh = sorted(set((a+b)/2 for a,b in combinations_with_replacement(data,2)))
    estimates = [(a+b)/2 for a,b in combinations_with_replacement(data,2)]
    epsilon = max(1.0, abs(walsh[0]), abs(walsh[-1]))
    bounds = [-math.inf] + walsh + [math.inf]
    accepted = [x for x in walsh if signed_p([d-x for d in data]) >= 0.05]
    for left,right in zip(bounds,bounds[1:]):
        probe = right-epsilon if left == -math.inf else left+epsilon if right == math.inf else (left+right)/2
        if signed_p([d-probe for d in data]) >= 0.05: accepted += [left,right]
    assert accepted
    return statistics.median(estimates), min(accepted), max(accepted)

def bootstrap(data):
    rng = random.Random(74319)
    values = sorted(statistics.median(rng.choices(data,k=len(data))) for _ in range(10000))
    return values[249], values[9749]

def fmt(x): return f'{x:+.3f}' if math.isfinite(x) else '-inf' if x < 0 else '+inf'

def self_check():
    assert signed_p([1]*5) == 0.0625
    assert signed_p([1]*10) == 0.001953125
    assert signed_p([-2,-1,0,1,2]) == 1
    assert exact_hl([1]*5)[1:] == (-math.inf,math.inf)
    assert exact_hl([1]*10)[1:] == (1,1)
    assert exact_hl(list(range(-5,5)))[1] <= 0 <= exact_hl(list(range(-5,5)))[2]

METRICS = [('wallMs','Warm-start wall ms',1),('buildMs','Run ms',1),('storageMs','Storage load ms',1),('makeRestoreMs','Make restore ms',1),('peakKiB','Peak RSS MiB',1024),('rssEndKiB','END RSS MiB',1024),('anonPeakKiB','Peak anon MiB',1024),('anonEndKiB','END anon MiB',1024)]
def main():
    self_check()
    rows = [json.loads(line) for line in open(sys.argv[1])]
    cells = defaultdict(dict)
    for row in rows:
        key=(row['condition'],row['delayMs'])
        ident=(row['round'],row['arm'])
        assert ident not in cells[key]
        cells[key][ident]=row
    print('# Legacy persistent-cache warm restore IO\n')
    print('Public synthetic data. Negative paired deltas mean improvement. Exact 95% Wilcoxon-HL intervals invert the exact conditional signed-rank test with ties and zero handling. The paired median and HL pseudomedian are separate estimates. Bootstrap percentile intervals cross-check the paired median. No multiplicity correction.\n')
    print('At n=5, the minimum two-sided exact p is 0.0625, so 95% exact intervals are unbounded. Exploratory results cannot pass the deciding gate. END is immediately after run completion, before parity hashing and compiler close. Peak RSS covers the process lifetime.\n')
    gates=[]
    for (condition,delay),cell in cells.items():
        arms=sorted(set(arm for _,arm in cell))
        n=len([r for r,a in cell if a=='main'])
        assert all(len([r for r,a in cell if a==arm])==n for arm in arms)
        print(f'## {condition}, {delay} ms read delay, n={n}\n')
        print('| Arm | Warm-start wall ms | Run ms | Storage ms | Make restore ms | Peak RSS MiB | END RSS MiB | Read requests |')
        print('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
        for arm in arms:
            group=[cell[(r,arm)] for r in range(1,n+1)]
            values=[statistics.median(row[k] for row in group)/div for k,_,div in METRICS[:6]]
            print('| '+arm+' | '+' | '.join(f'{x:.3f}' for x in values)+f' | {statistics.median(r["readRequests"] for r in group):.0f} |')
        print('\n| Arm - main | Metric | Paired median | HL estimate | Exact HL 95% interval | Bootstrap median 95% | Exact p | Signs -/0/+ |')
        print('| --- | --- | ---: | ---: | --- | --- | ---: | --- |')
        for arm in arms:
            if arm=='main':continue
            for key,title,div in METRICS:
                data=[(cell[(r,arm)][key]-cell[(r,'main')][key])/div for r in range(1,n+1)]
                hl,lo,hi=exact_hl(data);blo,bhi=bootstrap(data)
                signs='/'.join(str(sum(1 for x in data if pred(x))) for pred in [lambda x:x<0,lambda x:x==0,lambda x:x>0])
                print(f'| {arm} | {title} | {fmt(statistics.median(data))} | {fmt(hl)} | [{fmt(lo)}, {fmt(hi)}] | [{fmt(blo)}, {fmt(bhi)}] | {signed_p(data):.6f} | {signs} |')
                gates.append(dict(condition=condition,delay=delay,arm=arm,metric=key,n=n,median=statistics.median(data),hl=hl,lower=lo,upper=hi,bootstrapLower=blo,bootstrapUpper=bhi))
        print('\n### Restore D-state thread attribution\n')
        print('Estimated milliseconds from sampled thread state, clipped to timestamped storage-load windows. Thread names are kernel-truncated. This is not kernel-accounted I/O wait time.\n')
        print('| Arm | Thread name | Sampled D-state ms per launch, median |')
        print('| --- | --- | ---: |')
        for arm in arms:
            by_name=defaultdict(lambda:[0]*n)
            for repetition in range(1,n+1):
                for ident,value in cell[(repetition,arm)]['dStateMs'].items(): by_name[ident.split(':')[0]][repetition-1]+=value
            for name,values in sorted(by_name.items()): print(f'| {arm} | {name} | {statistics.median(values):.3f} |')
        print()
    with open(sys.argv[1]+'.gates.json','w') as out: json.dump(gates,out,indent=2)
if __name__=='__main__': main()
