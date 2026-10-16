import collections
import json
import pathlib
import re
import statistics
import sys
from analyze import samples, js_frame, OPERATIONS

root = pathlib.Path(sys.argv[1])
runs = []
for directory in sorted(root.glob('repeat-*')):
    m = json.load(open(directory / 'metrics.json'))
    counter = collections.Counter()
    operations = collections.Counter()
    leaves = {'no-js-frame': collections.Counter(), 'under-js-frame': collections.Counter()}
    representatives = {}
    total = 0
    sides = collections.Counter()
    depths = []
    unknown = 0
    for t, frames in samples(directory / 'perf.script'):
        if not m['marks']['buildStart'] <= t <= m['marks']['buildEnd']:
            continue
        total += 1
        depths.append(len(frames))
        first_js = next((i for i, (s, d) in enumerate(frames) if js_frame(s, d)), len(frames))
        side = 'under-js-frame' if first_js < len(frames) else 'no-js-frame'
        sides[side] += 1
        active = frames[:first_js]
        if active:
            leaves[side][active[0][0]] += 1
            unknown += active[0][0] == '[unknown]'
        joined = '\n'.join(s for s, d in active)
        for symbol in set(s for s, d in active):
            counter[symbol] += 1
        for operation, pattern in OPERATIONS.items():
            if re.search(pattern, joined):
                operations[operation] += 1
                if operation not in representatives:
                    representatives[operation] = [s for s, d in frames[:22]]
    if not total:
        raise SystemExit(f'No build samples in {directory}')
    print('QUALITY', directory.name, 'buildSamples', total, 'sides', dict(sides), 'unknownLeaf', unknown, 'medianDepth', statistics.median(depths), 'maxDepth', max(depths))
    print('LEAVES', directory.name)
    for side, counts in leaves.items():
        for symbol, count in counts.most_common(15):
            print(side, count, symbol)
    print('CHAINS', directory.name, json.dumps(representatives, indent=2))
    runs.append({'metrics': m, 'total': total, 'counter': counter, 'operations': operations})

print('INCLUSIVE SYMBOL CEILINGS: percentages of all build main-thread samples; overlapping')
interesting = sorted(set(s for r in runs for s in r['counter'] if re.search(r'rspack_binding_api|rspack_napi|napi_|napi::|ThreadSafeFunction|uv_', s)))
interesting.sort(key=lambda s: statistics.median(r['counter'][s] / r['total'] for r in runs), reverse=True)
for symbol in interesting[:40]:
    counts = [r['counter'][symbol] for r in runs]
    percentages = [100 * count / r['total'] for count, r in zip(counts, runs)]
    cpu_ms = [r['metrics']['mainCpuMs'] * count / r['total'] for count, r in zip(counts, runs)]
    print('SYMBOL', json.dumps(symbol), 'counts', counts, 'percent', [round(v, 3) for v in percentages], 'medianCpuMs', round(statistics.median(cpu_ms), 3))
print('OPERATION CEILINGS: overlapping')
for operation in OPERATIONS:
    counts = [r['operations'][operation] for r in runs]
    percentages = [100 * count / r['total'] for count, r in zip(counts, runs)]
    cpu_ms = [r['metrics']['mainCpuMs'] * count / r['total'] for count, r in zip(counts, runs)]
    print('OPERATION', operation, 'counts', counts, 'percent', [round(v, 3) for v in percentages], 'medianCpuMs', round(statistics.median(cpu_ms), 3))

print('SOURCE LINE EVIDENCE')
for directory in sorted(root.glob('repeat-*')):
    source = directory / 'source-lines.script'
    if not source.exists():
        continue
    lines = collections.Counter()
    for line in source.read_text(errors='replace').splitlines():
        if re.search(r'(?:rspack_binding_api|rspack_napi)/src/.*:\d+', line):
            lines[line.strip()] += 1
    for line, count in lines.most_common(18):
        print(directory.name, count, line)
