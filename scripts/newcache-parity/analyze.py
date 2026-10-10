import argparse
import collections
import json
import math
import pathlib
import statistics

parser = argparse.ArgumentParser()
parser.add_argument('directory')
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = pathlib.Path(args.directory)
records = []
failures = []
metadata = []
for file in root.rglob('*.json'):
    data = json.loads(file.read_text())
    if file.name == 'failures.json':
        failures.extend(data)
    elif file.name == 'metadata.json':
        metadata.append(data)
    elif isinstance(data, dict) and data.get('measured'):
        records.append(data)


def spread(values):
    return {'median': statistics.median(values), 'min': min(values), 'max': max(values), 'n': len(values)}


def sign_test(deltas):
    pos = sum(d > 0 for d in deltas)
    neg = sum(d < 0 for d in deltas)
    n = pos + neg
    p = min(1, 2 * sum(math.comb(n, k) for k in range(min(pos, neg) + 1)) / 2 ** n) if n else 1
    return {'positive': pos, 'negative': neg, 'ties': len(deltas) - n, 'two_sided_p': p}


def values(record):
    first, last = record['rounds'][0], record['rounds'][-1]
    result = {
        'done_ms': first['timestamps']['done']['wall_ms'],
        'user_ms': first['timestamps']['done']['user_ms'],
        'sys_ms': first['timestamps']['done']['sys_ms'],
        'make_ms': first['timestamps']['finishModules']['wall_ms'] - first['timestamps']['make']['wall_ms'],
        'post_make_ms': first['timestamps']['done']['wall_ms'] - first['timestamps']['finishModules']['wall_ms'],
        'end_ms': record['end']['wall_ms'],
        'idle_user_ms': record['end']['user_ms'] - record['idle_start']['user_ms'],
        'idle_sys_ms': record['end']['sys_ms'] - record['idle_start']['sys_ms'],
        'close_ms': record['closed']['wall_ms'] - record['close_start']['wall_ms'],
        'process_exit_ms': record['process_exit']['wall_ms'],
        'cache_done_mib': first['cache_done']['bytes'] / 2 ** 20,
        'cache_end_mib': record['cache_end']['bytes'] / 2 ** 20,
        'cache_closed_mib': record['cache_closed']['bytes'] / 2 ** 20,
    }
    if len(record['rounds']) > 1:
        result['watch_edits_ms'] = sum(r['timestamps']['done']['wall_ms'] - r['edit_start']['wall_ms'] for r in record['rounds'][1:])
        result['watch_user_ms'] = sum(r['timestamps']['done']['user_ms'] - r['edit_start']['user_ms'] for r in record['rounds'][1:])
        result['watch_sys_ms'] = sum(r['timestamps']['done']['sys_ms'] - r['edit_start']['sys_ms'] for r in record['rounds'][1:])
    for checkpoint, mem in [('done', first['memory_done']), ('last_done', last['memory_done']), ('end', record['memory_end']), ('closed', record['memory_closed'])]:
        for key, value in mem.items():
            result[f'{checkpoint}_{key}_mib'] = value / 2 ** 20
    return result


groups = collections.defaultdict(dict)
for record in records:
    key = record['host'], record['fixture_sources'], record['pair'], record['phase'], record['rep']
    if record['slot'] in groups[key]:
        raise RuntimeError(f'Duplicate observation: {key}')
    groups[key][record['slot']] = record
paired = collections.defaultdict(list)
incomplete = []
for key, pair in groups.items():
    if set(pair) != {0, 1}:
        incomplete.append(key)
        continue
    if [r['outputs'] for r in pair[0]['rounds']] != [r['outputs'] for r in pair[1]['rounds']]:
        raise RuntimeError(f'Output parity failure: {key}')
    paired[key[:4]].append((values(pair[0]), values(pair[1])))
summary = []
for key, pairs in sorted(paired.items()):
    metrics = {}
    for metric in pairs[0][0]:
        left = [p[0][metric] for p in pairs]
        right = [p[1][metric] for p in pairs]
        deltas = [b - a for a, b in zip(left, right)]
        ratios = [b / a for a, b in zip(left, right) if a != 0]
        absolute = sorted(abs(d) for d in deltas)
        metrics[metric] = {'left': spread(left), 'right': spread(right), 'paired_delta': spread(deltas),
                           'paired_ratio': spread(ratios) if ratios else None,
                           'absolute_delta_band_max': max(absolute), 'sign_test': sign_test(deltas)}
    summary.append({'host': key[0], 'fixture_sources': key[1], 'pair': key[2], 'phase': key[3], 'metrics': metrics})
pathlib.Path(args.output).write_text(json.dumps({'summary': summary, 'failures': failures, 'incomplete_pairs': incomplete,
                                                'metadata': metadata, 'output_parity_checked': True}, indent=2))
print(f'{len(records)} samples, {len(summary)} comparisons, {len(failures)} failures, {len(incomplete)} incomplete pairs')
