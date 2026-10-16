import json
import pathlib
import random
import statistics
from exact import paired_location

import sys
root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'bench-data/results')
metrics = ['buildMs', 'mainCpuMs', 'peakRss', 'steadyRss', 'closeRss', 'idleRss']
rows = []
rng = random.Random(20261016)
for metric in metrics:
    base = [json.loads((root / f'pair-{i}-base.json').read_text())[metric] for i in range(1, 11)]
    pr = [json.loads((root / f'pair-{i}-pr.json').read_text())[metric] for i in range(1, 11)]
    if base[0] is None:
        continue
    delta = [p - b for b, p in zip(base, pr)]
    boot = sorted(statistics.median(rng.choices(delta, k=10)) for _ in range(20000))
    b, p = statistics.median(base), statistics.median(pr)
    row = dict(metric=metric, baseMedian=b, prMedian=p, percent=(p / b - 1) * 100, pairedMedian=statistics.median(delta), pairedBootstrap95=[boot[499], boot[19499]], base=base, pr=pr)
    row.update(paired_location(base, pr))
    rows.append(row)
cpu = next((r for r in rows if r['metric'] == 'mainCpuMs'), None)
memory = [r for r in rows if r['metric'] in ['peakRss', 'steadyRss', 'idleRss']]
summary = dict(rows=rows, parity=json.loads((root / 'parity.json').read_text()), cpuClearlyLower=cpu is not None and cpu['exact95'][1] is not None and cpu['exact95'][1] < 0, memoryIncreaseDetected=any(r['exact95'][0] is not None and r['exact95'][0] > 0 for r in memory))
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
text = '| Metric | Base median | PR median | Change |\n| --- | ---: | ---: | ---: |\n'
for r in rows:
    scale = 1024 * 1024 if r['metric'].endswith('Rss') else 1000
    unit = 'MiB' if scale > 1000 else 's'
    text += f"| {r['metric']} | {r['baseMedian']/scale:.3f} {unit} | {r['prMedian']/scale:.3f} {unit} | {r['percent']:+.2f}% |\n"
(root / 'summary.md').write_text(text)
print(text)
print(json.dumps(summary, indent=2))
