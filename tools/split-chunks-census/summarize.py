import pathlib, json, statistics, sys, collections
root=pathlib.Path(sys.argv[1])
med=lambda a:statistics.median(a) if a else None
families={
 'combination_parent':'Combination preparation', 'module_keys':'Combination preparation','subset_rows':'Combination preparation','posting_rows':'Combination preparation','materialize_rows':'Combination preparation',
 'candidate_parent':'Candidate preparation','native_candidates':'Candidate preparation','callback_stage':'Candidate preparation','direct_candidates':'Candidate preparation',
 'candidate_snapshots':'Snapshot / initial validation','initial_validation':'Snapshot / initial validation','initial_invalid_drop':'Snapshot / initial validation',
 'remaining_cleanup':'Winner cleanup / invalid destruction','cleanup_invalid_drop':'Winner cleanup / invalid destruction',
 'initial_data_parent':'Initial module data','initial_sizes':'Initial module data','initial_placements':'Initial module data',
 'native_predicates':'Native predicate precompute',
 'serial_selection':'Serial selection','winner_placement_checks':'Winner checks / graph movement','graph_movement':'Winner checks / graph movement',
 'max_size':'Max size', 'previous_drop_submit':'Async table destruction','previous_drop_work':'Async table destruction','final_drop_submit':'Async table destruction','final_drop_work':'Async table destruction'}
parents={'combination_parent','candidate_parent','initial_data_parent','used_exports_parent'}
all_summary={}
for arm in ['priority-native','priority-callback','mixed-selective','mixed-saturated','every-priority-winner']:
 qfile=root/f'{arm}-qualification-summary.json'
 if not qfile.exists():continue
 qualification=json.loads(qfile.read_text())
 output={'qualification':qualification,'modes':{}}
 for mode,pattern in [('natural','normal-pair*-on.jsonl'),('controlled','controlled*.jsonl'),('three-core','three-core-pair*-on.jsonl')]:
  sites=collections.defaultdict(list);family_runs=collections.defaultdict(list);envelopes=[]
  for file in sorted(root.glob(f'{arm}-{pattern}')):
   rows=[json.loads(s) for s in file.read_text().splitlines()]
   for pass_id in sorted({r['pass'] for r in rows}):
    if pass_id==0:continue  # Rebuild census; cold raw rows remain in artifacts.
    windows=[r['row'] for r in rows if r['pass']==pass_id and r['row']['kind']=='site']
    envelope=next(w for w in windows if w['site']=='optimize_chunks')
    drops=[x for x in windows if x['site'].endswith('_drop_work')]
    values={};family=collections.defaultdict(lambda:[0.,0.,0.])
    for w in windows:
     if w['site']=='optimize_chunks':continue
     wall=(w['end_ns']-w['start_ns'])/1e6
     cpu=sum(w['cpu_end'][:2])-sum(w['cpu_start'][:2]);cpu/=1000
     wakes=w['counters_end'][3]-w['counters_start'][3]
     cold=w['counters_end'][0]-w['counters_start'][0]
     injected=w['counters_end'][2]-w['counters_start'][2]
     key=w['site'];v=values.setdefault(key,{'visits':0,'cold':0,'injections':0,'wakes':0,'cpu_ms':0,'wall_ms':0,'lengths':[],'sleeping':[],'overlapped':0})
     v['visits']+=1;v['cold']+=cold;v['injections']+=injected;v['wakes']+=wakes;v['cpu_ms']+=cpu;v['wall_ms']+=wall;v['lengths'].append(w['len']);v['sleeping'].append(w['sleeping_start'])
     overlapping=[x for x in drops if x is not w and x['start_ns']<w['end_ns'] and x['end_ns']>w['start_ns']]
     v['overlapped']+=bool(overlapping)
     if key in parents:
      children=[x for x in windows if x is not w and x['site']!='optimize_chunks' and not x['site'].endswith('_drop_work') and w['start_ns']<=x['start_ns'] and x['end_ns']<=w['end_ns']]
      # Remove only immediate/non-nested terminal children; parents keep their
      # labeled total in the site table. Async overlap is not subtracted.
      children=[x for x in children if not any(y is not x and y['start_ns']<=x['start_ns'] and x['end_ns']<=y['end_ns'] for y in children)]
      for x in children:
       wall-=(x['end_ns']-x['start_ns'])/1e6
       cpu-=(sum(x['cpu_end'][:2])-sum(x['cpu_start'][:2]))/1000
       wakes-=x['counters_end'][3]-x['counters_start'][3]
     f=families.get(key,key)
     family[f][0]+=wakes;family[f][1]+=cpu;family[f][2]+=wall
    for k,v in values.items():sites[k].append(v)
    for k,v in family.items():family_runs[k].append(v)
    envelopes.append({'wakes':envelope['counters_end'][3]-envelope['counters_start'][3],'cpu_ms':(sum(envelope['cpu_end'][:2])-sum(envelope['cpu_start'][:2]))/1000,'wall_ms':(envelope['end_ns']-envelope['start_ns'])/1e6})
  table={k:{metric:med([v[metric] for v in vs]) for metric in ['visits','cold','injections','wakes','cpu_ms','wall_ms','overlapped']}|{'sleeping_median':med([s for v in vs for s in v['sleeping']]),'sleeping_range':[min(s for v in vs for s in v['sleeping']),max(s for v in vs for s in v['sleeping'])],'length_0':sum(v['lengths'].count(0) for v in vs),'length_1':sum(v['lengths'].count(1) for v in vs)} for k,vs in sites.items()}
  total_wake=med([v['wakes'] for v in envelopes]);total_cpu=med([v['cpu_ms'] for v in envelopes])
  ranked=[{'family':k,'wakes':med([v[0] for v in vs]),'cpu_ms':med([v[1] for v in vs]),'wall_ms':med([v[2] for v in vs])} for k,vs in family_runs.items()]
  for v in ranked:
   v['wake_share']=v['wakes']/total_wake if total_wake else None
   v['cpu_share']=v['cpu_ms']/total_cpu if total_cpu else None
  ranked.sort(key=lambda v:v['wakes'],reverse=True)
  output['modes'][mode]={'passes':len(envelopes),'envelope_medians':{k:med([v[k] for v in envelopes]) for k in ['wakes','cpu_ms','wall_ms']},'sites':table,'ranked_nonexclusive_async':ranked,'warning':'Parent children removed only when nested. Async rows overlap and family sums are upper bounds, not exclusive shares.'}
 sensitivity=[]
 for allocation in ['normal','three-core']:
  for i in range(5):
   a=root/f'{arm}-{allocation}-pair{i}-off.json';b=root/f'{arm}-{allocation}-pair{i}-on.json'
   if not a.exists() or not b.exists():continue
   off=json.loads(a.read_text())['records'];on=json.loads(b.read_text())['records']
   for j in range(min(len(off),len(on))):
    sensitivity.append({'allocation':allocation,'pair':i,'phase':j,'wall_ratio':on[j]['wallMs']/off[j]['wallMs'],'cpu_ratio':(on[j]['cpuUserMs']+on[j]['cpuSystemMs'])/(off[j]['cpuUserMs']+off[j]['cpuSystemMs'])})
 output['whole_build_sensitivity']=sensitivity
 output['distortion_over_5_percent']=any(abs(med([x[k] for x in sensitivity if x['allocation']==a and x['phase']==p])-1)>.05 for a in ['normal','three-core'] for p in range(3) for k in ['wall_ratio','cpu_ratio'] if any(x['allocation']==a and x['phase']==p for x in sensitivity))
 all_summary[arm]=output
(root/'summary.json').write_text(json.dumps(all_summary,indent=2))
print(json.dumps({arm:{'qualified':s['qualification']['qualified'],'distorted':s['distortion_over_5_percent'],'natural_top3':s['modes']['natural']['ranked_nonexclusive_async'][:3]} for arm,s in all_summary.items()},indent=2))
