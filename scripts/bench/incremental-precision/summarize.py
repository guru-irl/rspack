from pathlib import Path
import json, re, statistics, sys
root = Path(sys.argv[1])
rows = []
def entries(node):
    if isinstance(node, dict):
        if 'message' in node or 'args' in node:
            yield node
        for k, v in node.items():
            if k not in ['message', 'args']:
                yield from entries(v)
    elif isinstance(node, list):
        for item in node: yield from entries(item)

def extract(record):
    counts, timers = {}, {}
    for logger, data in (record.get('logging') or {}).items():
        for entry in entries(data):
            msg = entry.get('message', '')
            if not msg and entry.get('args'): msg = ' '.join(map(str, entry['args']))
            c = re.search(r'(\d+) (modules|chunks) are affected, (\d+) in total', msg)
            if c: counts[logger] = {'affected': int(c[1]), 'total': int(c[3])}
            t = re.search(r'^(.*?):\s*([\d.]+)\s*(ms|s|μs|us)$', msg)
            if t:
                value = float(t[2]) * {'ms': 1, 's': 1000, 'μs': .001, 'us': .001}[t[3]]
                timers[f'{logger}/{t[1]}'] = value
            elif entry.get('type') == 'time' and len(entry.get('args', [])) >= 2:
                args = entry['args']
                if isinstance(args[1], list): timers[f'{logger}/{args[0]}'] = args[1][0] * 1000 + args[1][1] / 1e6
    return counts, timers

for path in root.rglob('*.json'):
    if not re.search(r'-(?:cold|\d+-(?:edit|revert))\.json$', path.name): continue
    r = json.loads(path.read_text())
    if 'wallMs' not in r: continue
    counts, timers = extract(r)
    rows.append({'path': str(path), 'variant': r['variant'], 'barrels': r['barrels'], 'split': r['split'], 'editKind': r['editKind'],
        'label': r['label'], 'wallMs': r['wallMs'], 'cpuMs': r['cpuUserMs'] + r['cpuSystemMs'], 'rss': r['rss'], 'peakRss': r['peakRss'],
        'chunks': len(r['chunks']), 'assets': len(r['outputs']), 'unchangedLogicalChunks': r['unchangedLogicalChunks'], 'counts': counts, 'timers': timers})

out = []
groups = {}
for r in rows:
    phase = 'cold' if r['label'] == 'cold' else 'revert' if r['label'].endswith('revert') else 'edit'
    key = (str(Path(r['path']).parent), r['variant'], r['barrels'], r['split'], r['editKind'], phase)
    groups.setdefault(key, []).append(r)
for key, values in groups.items():
    item = {'directory': key[0], 'variant': key[1], 'barrels': key[2], 'split': key[3], 'editKind': key[4], 'phase': key[5], 'n': len(values)}
    for field in ['wallMs', 'cpuMs', 'rss', 'peakRss', 'chunks', 'assets', 'unchangedLogicalChunks']:
        xs = [r[field] for r in values]
        item[field] = {'median': statistics.median(xs), 'min': min(xs), 'max': max(xs)}
    item['counts'] = {}
    for logger in set().union(*(r['counts'] for r in values)):
        xs = [r['counts'][logger]['affected'] for r in values if logger in r['counts']]
        item['counts'][logger] = {'median': statistics.median(xs), 'min': min(xs), 'max': max(xs), 'n': len(xs)}
    item['timers'] = {}
    for timer in set().union(*(r['timers'] for r in values)):
        xs = [r['timers'][timer] for r in values if timer in r['timers']]
        item['timers'][timer] = {'median': statistics.median(xs), 'min': min(xs), 'max': max(xs), 'n': len(xs)}
    out.append(item)
print(json.dumps({'records': len(rows), 'groups': out}, indent=2))
if not rows: raise SystemExit('No successful sample records found')
