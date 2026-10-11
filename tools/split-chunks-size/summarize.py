import json
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1])
rows = []
for version in (24, 25):
    values = {phase: [] for phase in ('cold', 'edit', 'revert')}
    for pair in range(7):
        original = json.loads((root / f'perf-{version}-{pair}-original.json').read_text())['records']
        changed = json.loads((root / f'perf-{version}-{pair}-changed.json').read_text())['records']
        for before, after in zip(original, changed, strict=True):
            assert before['phase'] == after['phase']
            for field in ('hashes', 'counts', 'modules', 'chunks'):
                assert before[field] == after[field], (version, pair, before['phase'], field)
            values[before['phase']].append((before, after))
    for phase, pairs in values.items():
        row = {'version': version, 'phase': phase, 'n': len(pairs), 'output_and_callback_parity': True}
        for field in ('wallMs', 'optimizeMs', 'peakRssKiB', 'steadyRssBytes'):
            row[field] = {
                'original_median': statistics.median(before[field] for before, _ in pairs),
                'changed_median': statistics.median(after[field] for _, after in pairs),
                'paired_median_percent': statistics.median((after[field] / before[field] - 1) * 100 for before, after in pairs),
                'paired_percent': [(after[field] / before[field] - 1) * 100 for before, after in pairs],
            }
        rows.append(row)
(root / 'summary.json').write_text(json.dumps(rows, indent=2))
print(json.dumps(rows, indent=2))
