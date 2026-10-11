import json
import os
import re
import statistics
from pathlib import Path

root = Path(os.environ['GITHUB_WORKSPACE']) / '.spider/scratch/next-max-t/results'
logger = 'rspack.SplitChunksPlugin'
labels = [
    'prepare module data', 'prepare cache groups', 'process cache groups', 'ensure max size fit',
    'stage0 native precompute', 'stage0 priority total', 'stage0 combinator',
    'stage0 matching total', 'stage0 matching native', 'stage0 matching JS-bearing',
    'stage0 matching assembly', 'stage0 candidate initial sizes', 'stage0 candidate selection',
    'stage0 candidate updates', 'stage0 split application', 'stage0 JS test phase',
    'stage0 JS chunks phase', 'stage0 JS name phase', 'stage0 native test phase',
    'stage0 native name phase', 'stage0 name_for_condition sampled', 'stage0 native matcher sampled CPU',
]
pairs = []
memories = {arm: [] for arm in ['baseline', 'diagnostic']}
for block in range(1, 4):
    arms = {arm: json.loads((root / f'{arm}-{block}/builds.json').read_text()) for arm in memories}
    for arm, builds in arms.items():
        assert len(builds) == 5 and all(b['outputParity'] for b in builds)
        memories[arm].append({'maxRssKiB': max(b['lifetimeMaxRssKiB'] for b in builds), 'steadyRss': statistics.median(b['memory']['rss'] for b in builds if b['kind'] == 'edit')})
    for build in range(5):
        assert (root / f'baseline-{block}/assets-{build}.json').read_bytes() == (root / f'diagnostic-{block}/assets-{build}.json').read_bytes()
        logging = json.loads((root / f'diagnostic-{block}/logging-{build}.json').read_text())
        entries = logging[logger]['entries']
        for label in labels:
            found = [e for e in entries if e['type'] == 'time' and e['message'].startswith(label + ':')]
            assert len(found) == 1, (block, build, label, found)
        children = {k: v for k, v in logging.items() if k.startswith(logger + '/')}
        assert len(children) == 10
        assert all(re.fullmatch(r'rspack\.SplitChunksPlugin/priority -?\d+(?:\.\d+)?', k) for k in children)
        for child in children.values():
            for label in labels[5:]:
                assert sum(e['type'] == 'time' and e['message'].startswith(label + ':') for e in child['entries']) == 1
    for baseline, diagnostic in zip(arms['baseline'], arms['diagnostic']):
        if baseline['kind'] != 'edit':
            continue
        b = baseline['timers'][logger + '/process cache groups']
        d = diagnostic['timers'][logger + '/process cache groups']
        pairs.append({'block': block, 'edit': baseline['build'], 'baselineMs': b, 'diagnosticMs': d, 'overheadPercent': (d / b - 1) * 100})
assert len(pairs) >= 6
bmedian = statistics.median(p['baselineMs'] for p in pairs)
dmedian = statistics.median(p['diagnosticMs'] for p in pairs)
overhead = (dmedian / bmedian - 1) * 100
summary = {'pairs': pairs, 'baselineMedianMs': bmedian, 'diagnosticMedianMs': dmedian, 'medianOverheadPercent': overhead, 'medianPairedOverheadPercent': statistics.median(p['overheadPercent'] for p in pairs), 'parity': 'byte-identical asset lists and direct file bytes on initial + 4 edits for 3 paired blocks', 'allTimersPresent': True, 'top10NumericPrioritiesPresent': True, 'memory': memories, 'spin': 'unset', 'threads': {'rayon': 4, 'tokio': 4}, 'fixture': 'Stage 0 at 4f084bdfcb; 60000 modules, 3000 chunks, 100 groups, 40 priorities; only asset-byte parity collection added', 'gatePassed': overhead <= 3}
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
assert overhead <= 3, f'Overhead gate failed: {overhead:.3f}% > 3%'
