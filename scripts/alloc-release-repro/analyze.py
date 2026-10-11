"""Run on the analysis host, never on the Mac. Uses existing downloads only."""
import collections
import json
from pathlib import Path
import statistics
import sys
import shutil

root = Path(sys.argv[1]).resolve()
for download in sorted(root.glob('artifacts-*')):
    run = download.name.removeprefix('artifacts-')
    bundles = list(download.glob('*'))
    if len(bundles) != 1:
        raise ValueError(f'Unexpected artifact layout: {download}')
    bundle = bundles[0]
    host = json.loads((bundle/'host.json').read_text())
    launches = []
    provenance = {}
    for name in ['core-provenance.json','binding-provenance.json','fixture.json']:
        provenance[name] = json.loads((bundle/name).read_text())
    for directory in sorted(bundle.glob('launch-*')):
        summary = json.loads((directory/'summary.json').read_text())
        events = [json.loads(s) for s in (directory/'events.jsonl').read_text().splitlines()]
        timeline = [json.loads(s) for s in (directory/'timeline.jsonl').read_text().splitlines()]
        metric = summary['metric']
        done = next(int(e['wall_ns']) for e in events if e['kind']=='build_done')
        close = next((int(e['wall_ns']) for e in events if e['kind']=='close_start'), 2**63)
        summary['rss_windows_mib'] = {}
        summary['anon_windows_mib'] = {}
        summary['v8_windows_mib'] = {e['kind']+(':'+str(e.get('seconds')) if 'seconds' in e else ''): {k:v/2**20 for k,v in e['memory'].items()} for e in events if e['kind'] in ['build_done','idle_mark']}
        for name, lo, hi in [('done',0,1),('early',3,5),('after_threads',12,15),('steady',55,60)]:
            window = [s for s in timeline if lo <= (s['wall_ns']-done)/1e9 <= hi]
            summary['rss_windows_mib'][name] = statistics.median(s['rss'] for s in window)/2**20
            summary['anon_windows_mib'][name] = statistics.median(s[metric] for s in window)/2**20
        # Windowed drops over 0.5 and 2 seconds, including immediately before completion.
        for span in [0.5,2.0]:
            drops=[]
            left=0
            for right, s in enumerate(timeline):
                while left < right and (s['wall_ns']-timeline[left]['wall_ns'])/1e9 > span:
                    left+=1
                before=timeline[left]
                if (s['wall_ns']-before['wall_ns'])/1e9 < span-0.15:
                    continue
                t=(s['wall_ns']-done)/1e9
                if t < -2 or t > 60:
                    continue
                gone=set(before['threads'])-set(s['threads'])
                drops.append({'after_done_s':t,'amount_mib':(before[metric]-s[metric])/2**20,'thread_count_before':before['num_threads'],'thread_count_after':s['num_threads'],'threads_gone':dict(collections.Counter(before['threads'][tid] or 'unknown' for tid in gone))})
            summary[f'largest_drop_{span}s']=max(drops,key=lambda d:d['amount_mib'])
        summary['thread_exit_drops']=[]
        for transition in summary['thread_transitions']:
            t=transition['after_done_s']
            if t >= (close-done)/1e9:
                continue
            before=[s[metric] for s in timeline if t-0.7 <= (s['wall_ns']-done)/1e9 < t-0.2]
            after=[s[metric] for s in timeline if t+0.1 <= (s['wall_ns']-done)/1e9 <= t+0.6]
            if before and after:
                summary['thread_exit_drops'].append({'after_done_s':t,'gone':transition['gone'],'drop_mib':(statistics.median(before)-statistics.median(after))/2**20})
        summary['sample_gap_ms']={'median':statistics.median((y['wall_ns']-x['wall_ns'])/1e6 for x,y in zip(timeline,timeline[1:])),'max':max((y['wall_ns']-x['wall_ns'])/1e6 for x,y in zip(timeline,timeline[1:]))}
        launches.append(summary)
    record={'run':run,'host':host,'provenance':provenance,'launches':launches}
    compact=root/f'analyzed-{run}.json'
    compact.write_text(json.dumps(record,indent=2))
    print('RUN',run,'arm',host['arm'],'fixture',provenance['fixture.json'],'version',provenance['core-provenance.json'].get('version'),'valid',sum(s['valid'] for s in launches),'delayed256',sum(s.get('delayed_256mib',False) for s in launches))
    for key in ['peak_rss_mib','peak_metric_mib','tail_0_1_mib','tail_3_5_mib','tail_12_15_mib','steady_55_60_mib','build_s']:
        values=[s[key] for s in launches if s['valid']]
        print(key,'median',round(statistics.median(values),3),'min',round(min(values),3),'max',round(max(values),3))
    print('LATE',[(s['launch'],round(s['largest_late_drop']['after_done_s'],3),round(s['largest_late_drop']['amount_mib'],3)) for s in launches])
    print('EXIT',[(s['launch'],[(round(e['after_done_s'],3),round(e['drop_mib'],3),list(e['gone'].values())) for e in s['thread_exit_drops'] if e['after_done_s']>0]) for s in launches])
    print('V8',[(s['launch'],s['v8_windows_mib'].get('build_done'),s['v8_windows_mib'].get('idle_mark:60')) for s in launches[:2]])
    # Statistics output is text, keep a separate compact diagnostic excerpt.
    logs=[]
    for directory in sorted(bundle.glob('launch-*')):
        stderr=(directory/'stderr.log').read_text()
        if stderr:
            logs.append(directory.name+'\n'+stderr)
    if logs:
        (root/f'diagnostics-{run}.txt').write_text('\n'.join(logs))
    # Keep summary/provenance, remove all raw extracted timelines and data.
    shutil.rmtree(download)
