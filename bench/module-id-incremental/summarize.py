import json
from pathlib import Path
import re
from statistics import median

root = Path(__file__).parent
rows = [json.loads(line) for file in sorted((root / 'data').glob('*-*/results.jsonl')) for line in file.read_text().splitlines()]
scenarios = ['initial', 'content', 'add10', 'add1000']
arms = ['main', 'branch', 'named']

def group(arm, scenario):
    return [row for row in rows if row['arm'] == arm and (row['scenario'].startswith('content-') if scenario == 'content' else row['scenario'] == scenario)]

def field(arm, scenario, key):
    return median(row[key] for row in group(arm, scenario))

def pass_ms(row, name):
    for entry in row['logging']['rspack.Compilation']['entries']:
        message = entry.get('message', '')
        if entry['type'] == 'time' and message.startswith(name + ':'):
            return float(re.search(r': ([0-9.]+) ms$', message)[1])
    raise ValueError('Missing pass timing ' + name)

for arm in arms:
    for scenario in scenarios:
        assert len(group(arm, scenario)) == (25 if scenario == 'content' else 5), (arm, scenario)
for trial in range(5):
    before = next(row for row in group('main', 'initial') if row['trial'] == trial)
    after = next(row for row in group('branch', 'initial') if row['trial'] == trial)
    assert before['outputHash'] == after['outputHash'], 'Cold output changed'
    assert before['totalJsBytes'] == after['totalJsBytes']
for row in rows:
    if row['arm'] == 'branch':
        assert row['changedExisting'] == 0, row['scenario']
        if row['scenario'].startswith('content-'):
            assert row['codeGenerated'] == 2, row['codeGenerated']

lines = ['# Synthetic compact-hashed watch comparison', '', '| Metric | Main | Branch | Change | Named reference |', '| --- | ---: | ---: | ---: | ---: |']
metrics = []
for scenario in scenarios:
    metrics.append((scenario + ' wall, ms', [field(arm, scenario, 'elapsedMs') for arm in arms], 2))
for scenario in ['content', 'add10', 'add1000']:
    for name in ['module ids', 'create module hashes', 'code generation', 'runtime requirements']:
        metrics.append((scenario + ' ' + name + ', ms', [median(pass_ms(row, name) for row in group(arm, scenario)) for arm in arms], 3))
    metrics.append((scenario + ' codegen processed', [field(arm, scenario, 'codeGenerated') for arm in arms], 0))
    metrics.append((scenario + ' existing ID churn', [field(arm, scenario, 'changedExisting') for arm in arms], 0))
    metrics.append((scenario + ' steady RSS after GC, MiB', [field(arm, scenario, 'steadyRssBytes') / 2**20 for arm in arms], 2))
peaks = []
for arm in arms:
    values = [json.loads(file.read_text())['peakRssBytes'] / 2**20 for file in (root / 'data').glob(arm + '-*/complete.json')]
    assert len(values) == 5
    peaks.append(median(values))
metrics.append(('Process peak RSS, MiB', peaks, 2))
metrics.append(('Cold JS bytes', [field(arm, 'initial', 'totalJsBytes') for arm in arms], 0))
for label, values, digits in metrics:
    change = f'{(values[1] / values[0] - 1) * 100:+.2f}%' if values[0] else '0%' if values[1] == 0 else 'N/A'
    cells = [f'{value:.{digits}f}' for value in values]
    lines.append(f'| {label} | {cells[0]} | {cells[1]} | {change} | {cells[2]} |')
lines += ['', 'Content edits: 25 per arm; each topology change: 5 per arm.', 'Cold output SHA-256 parity passed in all blocks; branch existing IDs stayed stable in every scenario.', 'RSS is Linux resident memory, not allocator live bytes. Steady RSS is sampled after explicit GC outside timed rebuilds.', 'Hosted-machine wall times are not instruction counts or cross-platform results.']
text = '\n'.join(lines) + '\n'
(root / 'data' / 'summary.md').write_text(text)
(root / 'data' / 'summary.json').write_text(json.dumps([{'metric': label, 'main': values[0], 'branch': values[1], 'named': values[2]} for label, values, digits in metrics], indent=2))
print(text)
