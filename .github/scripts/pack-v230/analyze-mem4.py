#!/usr/bin/env python3
import json
import random
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1])
base = sys.argv[2]
treatment = sys.argv[3]
pairs = int(sys.argv[4])
if pairs < 5:
    raise SystemExit('at least five paired runs are required')

def same_outputs(a, b):
    return len(a) == len(b) == 3 and all(a[i]['outputs'] == b[i]['outputs'] for i in range(3))

# Verify the comparison notices an independently changed result in every phase.
control = [{'outputs': [[f'file-{i}-a', f'hash-{i}-a'], [f'file-{i}-b', f'hash-{i}-b']]} for i in range(3)]
if not same_outputs(control, control):
    raise SystemExit('parity positive control failed')
for i in range(3):
    mutant = json.loads(json.dumps(control))
    mutant[i]['outputs'][0][1] = 'different'
    if same_outputs(control, mutant):
        raise SystemExit(f'parity negative control failed for phase {i}')
    swapped = json.loads(json.dumps(control))
    swapped[i]['outputs'][0][1], swapped[i]['outputs'][1][1] = swapped[i]['outputs'][1][1], swapped[i]['outputs'][0][1]
    if same_outputs(control, swapped):
        raise SystemExit(f'parity assignment control failed for phase {i}')

count = json.loads((root / 'fixture-count.json').read_text())
if count.get('modules', 0) < 30000:
    raise SystemExit('fixture smoke did not build at least 30000 modules')

runs = {}
for arm in (base, treatment):
    runs[arm] = []
    for i in range(1, pairs + 1):
        file = root / f'{arm}-{i}.jsonl'
        data = [json.loads(line) for line in file.read_text().splitlines() if line.startswith('{')]
        if [r.get('phase') for r in data] != [0, 1, 2]:
            raise SystemExit(f'{file}: expected exactly three ordered phases')
        if any(r['rss'] <= 0 or r['windowPeakRss'] < r['rss'] or r['elapsedMs'] <= 0 for r in data):
            raise SystemExit(f'{file}: invalid phase values or incomplete module graph')
        if data[0]['outputs'] == data[1]['outputs'] or data[1]['outputs'] == data[2]['outputs']:
            raise SystemExit(f'{file}: watch edits did not change output')
        lifetime_peak_kib = int((root / f'{arm}-{i}.peak-kib').read_text().strip())
        if lifetime_peak_kib <= 0:
            raise SystemExit(f'{file}: invalid lifetime peak')
        runs[arm].append((data, lifetime_peak_kib * 1024))

reference = runs[base][0][0]
for arm in (base, treatment):
    for i, (data, _) in enumerate(runs[arm], 1):
        if not same_outputs(reference, data):
            raise SystemExit(f'{arm} pair {i}: output mismatch')

metrics = {'lifetime_peak': (lambda data, peak: peak, 1048576, 'MiB')}
for phase, name in enumerate(('cold', 'edit1', 'edit2')):
    metrics[f'{name}_rss'] = (lambda data, peak, p=phase: data[p]['rss'], 1048576, 'MiB')
    metrics[f'{name}_window_peak'] = (lambda data, peak, p=phase: data[p]['windowPeakRss'], 1048576, 'MiB')
    metrics[f'{name}_ms'] = (lambda data, peak, p=phase: data[p]['elapsedMs'], 1, 'ms')

rng = random.Random(20261106)
print(f'baseline={base} treatment={treatment} pairs={pairs} output_parity=pass')
print('metric,unit,baseline_median,treatment_median,paired_delta_median,delta_ci95_low,delta_ci95_high')
for metric, (extract, scale, unit) in metrics.items():
    b = [extract(*r) / scale for r in runs[base]]
    t = [extract(*r) / scale for r in runs[treatment]]
    deltas = [v - u for u, v in zip(b, t)]
    bootstrap = sorted(statistics.median(rng.choices(deltas, k=pairs)) for _ in range(10000))
    lo = bootstrap[249]
    hi = bootstrap[9749]
    print(f'{metric},{unit},{statistics.median(b):.3f},{statistics.median(t):.3f},{statistics.median(deltas):.3f},{lo:.3f},{hi:.3f}')
