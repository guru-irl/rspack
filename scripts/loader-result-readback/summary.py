import json
import math
import pathlib
import statistics
import sys
from exact import paired_location

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'bench-data/results')
environment = json.loads((root / 'environment.json').read_text())
windows = environment['platform'] == 'win32'
assert (environment['platform'], environment['arch']) in [('win32', 'x64'), ('darwin', 'arm64'), ('linux', 'x64')]
assert environment['base'] == 'd9d09d4152cd15fc46eb5d1cb8d9b227bfcd39eb'
assert environment['pr'] == 'c2b473322d3d6c1292f8a124cdc4206ce52b35e3'
parity = json.loads((root / 'parity.json').read_text())
identities = json.loads((root / 'build-identities.json').read_text())
assert parity['bindings'] == identities and identities['base'] != identities['pr']
assert parity['identical'] and parity['runs'] == (42 if windows else 22)
schedule = json.loads((root / 'schedule.json').read_text())
orders = [['base1', 'base2', 'pr1', 'pr2'], ['pr2', 'pr1', 'base2', 'base1'], ['base2', 'pr2', 'pr1', 'base1'], ['pr1', 'base1', 'base2', 'pr2']]
expected = [('base', 'base', 0), ('pr', 'pr', 0)]
for block in range(1, 11):
    families = orders[(block - 1) % 4] if windows else (['base', 'pr'] if block % 2 else ['pr', 'base'])
    expected.extend(('base' if family.startswith('base') else 'pr', family, block) for family in families)
assert [(row['arm'], row['family'], row['block']) for row in schedule] == expected
assert len(schedule) == parity['runs']
records = []
for item in schedule:
    record = json.loads((root / item['file']).read_text())
    identity = record['bindingIdentity']
    assert record['bindingSha256'] == identity['bindingSha256'] == identities[item['arm']]
    assert identity['verifiedInRequireCache']
    if environment['platform'] == 'linux':
        assert identity['verifiedInMaps'] and identity['mappedSegments'] > 0
    assert record['outputFiles'] == parity['files']
    assert record['loaderCalls'] == {'noop': 60701, 'ast': 6000, 'rewrite': 3000}
    for snapshot in ['end', 'close', 'postGc']:
        value = record['snapshots'][snapshot]
        assert value['nativeEstimate'] == value['process']['rss'] - value['v8']['total_physical_size']
    record['_schedule'] = item
    records.append(record)
measured = [record for record in records if record['_schedule']['block'] > 0]
metrics = [('peakRss', 'Peak OS high-water RSS / working set', 'MiB')]
for snapshot, label in [('end', 'END'), ('close', 'Post-close, pre-GC'), ('postGc', 'Post-GC')]:
    for field in ['used_heap_size', 'total_heap_size', 'total_physical_size', 'malloced_memory', 'external_memory']:
        metrics.append((f'snapshots.{snapshot}.v8.{field}', f'{label}: V8 {field}', 'MiB'))
    for field in ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']:
        metrics.append((f'snapshots.{snapshot}.process.{field}', f'{label}: process {field}', 'MiB'))
    metrics.append((f'snapshots.{snapshot}.nativeEstimate', f'{label}: native estimate', 'MiB'))
metrics.append(('buildMs', 'Build wall', 's'))
metrics.extend([('gcActivity.count', 'Build GC: total count', 'count'), ('gcActivity.durationMs', 'Build GC: total duration', 'ms')])
kinds = sorted({1, 4, 8, 16} | {int(kind) for record in records for kind in record['gcActivity']['byKind']})
for kind in kinds:
    for field, unit in [('count', 'count'), ('durationMs', 'ms')]:
        metrics.append((f'gcActivity.byKind.{kind}.{field}', f'Build GC kind {kind}: {field}', unit))

def value(record, metric):
    current = record
    for field in metric.split('.'):
        if field not in current and metric.startswith('gcActivity.byKind.'):
            return 0
        current = current[field]
    assert isinstance(current, (int, float)) and math.isfinite(current)
    return current

rows, aa = [], []
for metric, label, unit in metrics:
    arms = {arm: [value(record, metric) for record in measured if record['_schedule']['arm'] == arm] for arm in ['base', 'pr']}
    contrasts = {arm: [] for arm in ['base', 'pr']}
    same_build = {arm: [] for arm in ['base', 'pr']}
    for block in range(1, 11):
        for arm in ['base', 'pr']:
            block_records = [record for record in measured if record['_schedule']['block'] == block and record['_schedule']['arm'] == arm]
            assert len(block_records) == (2 if windows else 1)
            contrasts[arm].append(statistics.mean(value(record, metric) for record in block_records))
            if windows:
                family_values = {record['_schedule']['family']: value(record, metric) for record in block_records}
                same_build[arm].append(family_values[arm + '2'] - family_values[arm + '1'])
    delta = [p - b for b, p in zip(contrasts['base'], contrasts['pr'])]
    b, p = [statistics.median(arms[arm]) for arm in ['base', 'pr']]
    row = dict(metric=metric, label=label, unit=unit, baseMedian=b, prMedian=p, percent=(p / b - 1) * 100 if b else None, pairedMedian=statistics.median(delta), base=arms['base'], pr=arms['pr'], contrasts=contrasts, differences=delta)
    row.update(paired_location(contrasts['base'], contrasts['pr']))
    row['increased'] = row['exact95'][0] is not None and row['exact95'][0] > 0
    rows.append(row)
    if windows:
        for arm in ['base', 'pr']:
            differences = same_build[arm]
            aa.append(dict(metric=metric, label=label, arm=arm, unit=unit, median=statistics.median(differences), minimum=min(differences), maximum=max(differences), medianAbsolute=statistics.median(abs(d) for d in differences), maximumAbsolute=max(abs(d) for d in differences), differences=differences))
by_metric = {row['metric']: row for row in rows}
used = by_metric['snapshots.postGc.v8.used_heap_size']
native = by_metric['snapshots.postGc.nativeEstimate']
memory_rows = [row for row in rows if row['unit'] == 'MiB']
classification = 'GC timing under the pre-registered rule' if not used['increased'] and not native['increased'] else 'unexplained under the pre-registered rule'
summary = dict(environment=environment, parity=parity, rows=rows, aa=aa, memoryIncreaseDetected=any(row['increased'] for row in memory_rows), increasedMetrics=[row['metric'] for row in memory_rows if row['increased']], windowsClassification=classification if windows else None, samples=len(measured), inference='Ten Windows contrasts (mean PR minus mean base) or ten macOS/Linux paired differences; exact signed-rank inversion; marginal intervals, not multiplicity-adjusted')
(root / 'summary.json').write_text(json.dumps(summary, indent=2))

def scale(unit):
    return 1024 * 1024 if unit == 'MiB' else 1000 if unit == 's' else 1

def number(value, unit, signed=False):
    return format(value / scale(unit), '+.3f' if signed else '.3f')

text = f"# {environment['platform']} / {environment['arch']}\n\nMemory increase detected: {summary['memoryIncreaseDetected']}.\n\n"
if windows:
    text += f'Windows classification: {classification}.\n\n'
text += '| Metric (unit) | Base median | PR median | Change | Paired/block median delta | HL delta | Exact 95% interval | Verdict |\n| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |\n'
for row in rows:
    unit = row['unit']
    low, high = row['exact95']
    assert low is not None and high is not None
    interval = f'[{number(low, unit, True)}, {number(high, unit, True)}]'
    change = f"{row['percent']:+.2f}%" if row['percent'] is not None else 'n/a'
    verdict = 'INCREASED' if row['increased'] else 'No increase detected'
    text += f"| {row['label']} ({unit}) | {number(row['baseMedian'], unit)} | {number(row['prMedian'], unit)} | {change} | {number(row['pairedMedian'], unit, True)} | {number(row['hodgesLehmann'], unit, True)} | {interval} | {verdict} |\n"
if windows:
    text += '\n## Same-build spreads (family 2 minus family 1)\n\n| Metric (unit) | Arm | Median delta | Signed range | Median absolute | Maximum absolute |\n| --- | --- | ---: | --- | ---: | ---: |\n'
    for row in aa:
        unit = row['unit']
        text += f"| {row['label']} ({unit}) | {row['arm']} | {number(row['median'], unit, True)} | [{number(row['minimum'], unit, True)}, {number(row['maximum'], unit, True)}] | {number(row['medianAbsolute'], unit)} | {number(row['maximumAbsolute'], unit)} |\n"
(root / 'summary.md').write_text(text)
print(text)
print(f"VERIFIED processes={len(records)} measured={len(measured)} native_identity=all parity=all fixed_schedule=all")
