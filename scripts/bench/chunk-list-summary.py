import json
import random
import statistics
import sys
from pathlib import Path


def paired_interval(values):
    rng = random.Random(1837)
    boot = sorted(statistics.median(rng.choices(values, k=len(values))) for _ in range(20000))
    return [boot[499], boot[19499]]


def summarize(rows):
    output = {}
    for kind in ['steady', 'crossing']:
        pairs = []
        for pair in range(7):
            selected = [row for row in rows if row['kind'] == kind and row['pair'] == pair]
            assert len(selected) == 2, (kind, pair, 'Missing or duplicate sample')
            values = {row['arm']: row for row in selected}
            assert set(values) == {'base', 'fix'}
            for row in selected:
                assert row['dynamicImports'] >= 5000 and row['chunkGroups'] >= 300
                assert len(row['samples']) == 12 and all(value > 0 for value in row['samples'])
                assert len(row['nativeSha256']) == 64
            pairs.append(values)
        bases = [statistics.median(pair['base']['samples']) for pair in pairs]
        fixes = [statistics.median(pair['fix']['samples']) for pair in pairs]
        deltas = [100 * (fix / base - 1) for base, fix in zip(bases, fixes)]
        absolute = [fix - base for base, fix in zip(bases, fixes)]
        output[kind] = {
            'pairs': len(pairs), 'baseMedianMs': statistics.median(bases),
            'fixMedianMs': statistics.median(fixes), 'pairedMedianPercent': statistics.median(deltas),
            'paired95PercentInterval': paired_interval(deltas),
            'pairedMedianDeltaMs': statistics.median(absolute), 'paired95DeltaMsInterval': paired_interval(absolute),
            'pairedPercentDeltas': deltas,
            'basePeakRssKiB': statistics.median(pair['base']['peakRssKiB'] for pair in pairs),
            'fixPeakRssKiB': statistics.median(pair['fix']['peakRssKiB'] for pair in pairs),
            'baseSteadyRssKiB': statistics.median(pair['base']['steadyRssKiB'] for pair in pairs),
            'fixSteadyRssKiB': statistics.median(pair['fix']['steadyRssKiB'] for pair in pairs),
            'baseCpuToWallRatio': statistics.median(statistics.median(pair['base']['cpuSamples']) / statistics.median(pair['base']['samples']) for pair in pairs),
            'fixCpuToWallRatio': statistics.median(statistics.median(pair['fix']['cpuSamples']) / statistics.median(pair['fix']['samples']) for pair in pairs),
        }
    return output


# An interval must identify a fixed positive cost and a fixed negative cost.
assert paired_interval([10] * 7) == [10, 10]
assert paired_interval([-10] * 7) == [-10, -10]
assert paired_interval([0] * 7) == [0, 0]
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
assert len(rows) == 28, 'Expected exactly 28 successful processes'
hashes = {arm: {row['nativeSha256'] for row in rows if row['arm'] == arm} for arm in ['base', 'fix']}
assert all(len(value) == 1 for value in hashes.values()), 'Mixed bindings within an arm'
assert hashes['base'] != hashes['fix'], 'Both arms used the same binding'
result = summarize(rows)
try:
    summarize(rows[:-1])
except AssertionError:
    pass
else:
    raise AssertionError('The missing-sample control passed')
Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
