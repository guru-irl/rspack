from pathlib import Path
import json
import statistics
import sys

root = Path(sys.argv[1])
def median(xs):
    return statistics.median(xs) if xs else None
runs = {}
for p in sorted(root.glob('*/builds.json')):
    builds = json.loads(p.read_text())
    runs[p.parent.name] = builds
summary = {'runs': len(runs), 'per_edit': {}, 'aggregate': {}}
for variant in ['baseline', 'prototype']:
    selected = [v for k,v in runs.items() if k.endswith('-' + variant)]
    if not selected:
        continue
    per_edit = []
    for index in range(min(map(len, selected))):
        rows = [r[index] for r in selected]
        per_edit.append({
            'edit': index,
            'n': len(rows),
            'done_rss_mib': median([r['doneMemory']['rss'] / 2**20 for r in rows]),
            'post_gc_rss_mib': median([r['postGcMemory']['rss'] / 2**20 for r in rows]),
            'post_gc_js_mib': median([r['postGcMemory']['heapUsed'] / 2**20 for r in rows]),
            'peak_rss_mib': median([r['sampledPeakRss'] / 2**20 for r in rows]),
            'compiler_ms': median([r['compilerMs'] for r in rows]),
            'wall_ms': median([r['editWallMs'] for r in rows]),
            'native_live_mib': median([r['postGcNative'][0] / 2**20 for r in rows if r.get('postGcNative')]),
        })
    summary['per_edit'][variant] = per_edit
    summary['aggregate'][variant] = {
        'pairs': len(selected),
        'run_peak_rss_mib': median([max(r['sampledPeakRss'] for r in rows) / 2**20 for rows in selected]),
        'run_lifetime_peak_rss_mib': median([max(r['lifetimeMaxRssKiB'] for r in rows) / 1024 for rows in selected]),
        'tail_done_rss_mib': median([median([r['doneMemory']['rss']/2**20 for r in rows[-5:]]) for rows in selected]),
        'tail_post_gc_rss_mib': median([median([r['postGcMemory']['rss']/2**20 for r in rows[-5:]]) for rows in selected]),
        'rebuild_ms': median([median([r['compilerMs'] for r in rows[1:]]) for rows in selected]),
        'rebuild_wall_ms': median([median([r['editWallMs'] for r in rows[1:]]) for rows in selected]),
    }
print(json.dumps(summary, indent=2))
