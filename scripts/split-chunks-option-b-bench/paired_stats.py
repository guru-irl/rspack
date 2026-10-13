import math,random,statistics

def hl(d):return statistics.median([(x+y)/2 for i,x in enumerate(d) for y in d[i:]])
def exact_interval(d):
 n=len(d);counts=[1]
 for rank in range(1,n+1):
  c=counts+[0]*rank
  for i,v in enumerate(counts):c[i+rank]+=v
  counts=c
 cumulative=0;critical=-1
 for i,v in enumerate(counts):
  cumulative+=v
  if cumulative/2**n<=.025:critical=i
  else:break
 w=sorted((x+y)/2 for i,x in enumerate(d) for y in d[i:])
 if critical<0:return [-math.inf,math.inf],1
 coverage=1-2*sum(counts[:critical+1])/2**n
 return [w[critical],w[len(w)-critical-1]],coverage

def summarize(a,b):
 d=[y-x for x,y in zip(a,b)];assert len(d)>=10
 interval,coverage=exact_interval(d)
 rng=random.Random(271828);samples=sorted(hl(rng.choices(d,k=len(d))) for _ in range(10000))
 boot=[samples[249],samples[9749]]
 nz=[x for x in d if x];ranks=[1+sum(abs(y)<abs(x) for y in nz)+(sum(abs(y)==abs(x) for y in nz)-1)/2 for x in nz]
 distribution={0:1}
 for rank in ranks:
  new=dict(distribution)
  for total,count in distribution.items():new[total+rank]=new.get(total+rank,0)+count
  distribution=new
 observed=sum(rank for rank,x in zip(ranks,nz) if x>0);denom=2**len(nz)
 p=min(1,2*min(sum(c for t,c in distribution.items() if t<=observed),sum(c for t,c in distribution.items() if t>=observed))/denom)
 return {'n':len(d),'baseMedian':statistics.median(a),'otherMedian':statistics.median(b),'pairedMedian':statistics.median(d),'hl':hl(d),'ci95':interval,'exactCoverage':coverage,'bootstrap95':boot,'exactWilcoxonP':p,'increase':interval[0]>0,'win':interval[1]<0,'deltas':d}

if __name__=='__main__':
 assert exact_interval(list(range(1,11)))==([3.0,8.0],.951171875)
 r=summarize([0]*10,[1]*10);assert r['ci95']==[1,1] and r['increase']
 r=summarize([1]*10,[0]*10);assert r['win']
 r=summarize([0]*10,[0]*10);assert not r['increase'] and not r['win']
 print('statistical checks passed')
