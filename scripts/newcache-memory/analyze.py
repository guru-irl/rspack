import json
from pathlib import Path
import math
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'results')
meta = json.loads((root / 'metadata.json').read_text())
index = json.loads((root / 'index.json').read_text())
records = [json.loads((root / f'{name}.json').read_text()) for name in index]
if not (root / 'success.json').exists():
    raise RuntimeError('Failed or partial dataset, not an accepted result')

def metric(record, name):
    first = record['rounds'][0]
    if name in ('wall_ms', 'cpu_ms'):
        return first['done'][name]
    if name == 'warm_peak':
        return first['memory_done']['peak']
    if name == 'lifetime_peak':
        return record['memory_closed']['peak']
    if name == 'disk_bytes':
        return record['cache_end']['bytes']
    anchor, counter = name.split(':')
    return (first['memory_done'] if anchor == 'done' else record['memory_end'])[counter]

metrics = ['warm_peak', 'lifetime_peak', 'wall_ms', 'cpu_ms', 'disk_bytes']
metrics += (['done:RssAnon', 'end:RssAnon', 'done:RssFile', 'end:RssFile']
            if meta['platform']['system'] == 'Linux' else ['done:phys_footprint', 'end:phys_footprint'])
summary = {'metadata': meta, 'metrics': {}}
for name in metrics:
    diffs = {}
    relative = {}
    for comparison in ('AA', 'AB'):
        rows = [r for r in records if r['comparison'] == comparison]
        pairs = {i: {r['slot']: r for r in rows if r['pair'] == i} for i in range(1, 21)}
        if any(set(pair) != {0, 1} for pair in pairs.values()):
            raise RuntimeError('Missing complete fixed-n pair')
        diffs[comparison] = [metric(pair[1], name) - metric(pair[0], name) for pair in pairs.values()]
        relative[comparison] = [100 * d / metric(pair[0], name)
                                for d, pair in zip(diffs[comparison], pairs.values())]
    def stats(values):
        mean = sum(values) / len(values)
        sd = math.sqrt(sum((x - mean) ** 2 for x in values) / (len(values) - 1))
        se = sd / math.sqrt(len(values))
        return {'n': len(values), 'mean': mean, 'ci95': [mean - 2.093024 * se, mean + 2.093024 * se],
                'upper95': mean + 1.729133 * se, 'sd': sd, 'min': min(values), 'max': max(values)}
    aa, ab = stats(diffs['AA']), stats(diffs['AB'])
    margin = 8 * 1024 * 1024
    tail_threshold = max(margin, sorted(diffs['AA'])[18])
    flags = [i + 1 for i, delta in enumerate(diffs['AB']) if delta > tail_threshold]
    is_memory = name not in ('wall_ms', 'cpu_ms', 'disk_bytes')
    summary['metrics'][name] = {'aa': aa, 'ab': ab, 'relative_percent': stats(relative['AB']),
        'mde_80': (1.729133 + 0.842) * aa['sd'] / math.sqrt(20),
        'memory_margin_bytes': margin if is_memory else None,
        'mean_equivalent': ab['upper95'] <= margin if is_memory else None,
        'tail_confirmation_required': flags if is_memory else [],
        'tail_rule': 'A flagged tail requires a separate pre-set five-pair confirmation; not passed by omission.'}
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
lines = ['# Paired prototype results', '', f"Candidate: {meta['candidate']}; phase: {meta['phase']}; 20 A/A and 20 A/B pairs.", '',
         '| Metric | Mean paired delta | 95% CI | Relative delta | A/A MDE | Tail flags |',
         '|---|---:|---|---:|---:|---|']
for name, data in summary['metrics'].items():
    divisor = 1048576 if name not in ('wall_ms', 'cpu_ms') else 1
    unit = 'MiB' if divisor != 1 else 'ms'
    ab = data['ab']
    lines.append(f"| {name} | {ab['mean']/divisor:.3f} {unit} | [{ab['ci95'][0]/divisor:.3f}, {ab['ci95'][1]/divisor:.3f}] | {data['relative_percent']['mean']:.3f}% | {data['mde_80']/divisor:.3f} | {data['tail_confirmation_required']} |")
(root / 'summary.md').write_text('\n'.join(lines) + '\n')
print('\n'.join(lines))
