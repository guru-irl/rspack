import collections
import json
import pathlib
import re
import statistics
import sys
from analyze import samples, js_frame, category, OPERATIONS

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
    unknown_dsos = collections.Counter()
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
            if active[0][0] == '[unknown]':
                unknown_dsos[active[0][1]] += 1
        joined = '\n'.join(s for s, d in active)
        for symbol in set(s for s, d in active):
            counter[symbol] += 1
        matched = set()
        for operation, pattern in OPERATIONS.items():
            if re.search(pattern, joined, re.M):
                matched.add(operation)
                operations[operation] += 1
                if operation not in representatives:
                    representatives[operation] = [s for s, d in frames[:22]]
        direct = category(active) not in {'GC', 'kernel / unresolved', 'empty / unwound', 'other / unresolved'}
        if 'ModuleObject to-JS including lookup' in matched and direct:
            operations['outbound module direct user non-GC'] += 1
        if {'JsLoaderContext to-JS', 'JsLoaderContext from-JS'} & matched:
            operations['all context conversion union'] += 1
            if 'ModuleObject to-JS including lookup' not in matched:
                operations['context conversion excluding outbound module'] += 1
                if direct:
                    operations['non-module context direct user non-GC'] += 1
    if not total:
        raise SystemExit(f'No build samples in {directory}')
    print('QUALITY', directory.name, 'buildSamples', total, 'sides', dict(sides), 'unknownLeaf', unknown, 'medianDepth', statistics.median(depths), 'maxDepth', max(depths), 'unknownDso', dict(unknown_dsos))
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
for operation in [*OPERATIONS, 'all context conversion union', 'context conversion excluding outbound module', 'outbound module direct user non-GC', 'non-module context direct user non-GC']:
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
    print('SOURCE FILE', directory.name, 'bytes', source.stat().st_size)
    log = directory / 'source-lines.log'
    if log.exists():
        print('SOURCE LOG', log.read_text(errors='replace')[:500])
    for line in source.read_text(errors='replace').splitlines():
        if re.search(r'\.rs:\d+', line):
            lines[line.strip()] += 1
    for line, count in lines.most_common(18):
        print(directory.name, count, line)
