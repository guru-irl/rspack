import collections
import json
import pathlib
import random
import re
import statistics

root = pathlib.Path(__file__).parent

def median(rows, field):
    return statistics.median(r[field] for r in rows)

def passes(row):
    out = {}
    for entry in row.get('logging', {}).get('rspack.Compilation', {}).get('entries', []):
        msg = entry.get('message', '')
        if entry.get('type') == 'time':
            out[msg.split(':')[0]] = msg
    return out

lines = []
def emit(text=''):
    print(text)
    lines.append(text)

for tag in ['plain', 'eval']:
    target = root / 'data' / tag
    if not target.exists():
        continue
    rows = [json.loads(s) for s in (target / 'results.jsonl').read_text().splitlines()]
    arms = ['deterministic', 'named', 'hashed', 'compact-hashed']
    emit(f'## {tag} results')
    env = json.loads((target / 'environment.json').read_text())
    emit(f"Core {env['core']['name']} {env['core']['version']}; Node {env['node']}; {env['cpus']} CPUs; trials={env['trials']}")
    emit('| Arm | Scenario | n | Wall median ms [min,max] | Stats ms | ID modules | Re-code-generated | Existing ID changes | JS bytes |')
    emit('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for arm in arms:
        for scenario in ['initial', 'content', 'add10', 'add1000', 'insert-first']:
            group = [r for r in rows if r['arm'] == arm and (r['scenario'].startswith('content-') if scenario == 'content' else r['scenario'] == scenario)]
            if not group:
                continue
            emit(f"| {arm} | {scenario} | {len(group)} | {median(group,'elapsedMs'):.2f} [{min(r['elapsedMs'] for r in group):.2f},{max(r['elapsedMs'] for r in group):.2f}] | {median(group,'statsTimeMs'):.1f} | {median(group,'idModules'):g} | {median(group,'codeGenerated'):g} | {median(group,'changedExisting'):g}/{median(group,'commonExisting'):g} | {median(group,'totalJsBytes'):g} |")
    emit('\n### Median pass times, ms')
    emit('| Arm | Scenario | Module IDs | Module hashes | Codegen | Runtime requirements |')
    emit('| --- | --- | ---: | ---: | ---: | ---: |')
    for arm in arms:
        for scenario in ['content', 'add10', 'add1000']:
            group = [r for r in rows if r['arm'] == arm and (r['scenario'].startswith('content-') if scenario == 'content' else r['scenario'] == scenario)]
            cells = []
            for name in ['module ids', 'create module hashes', 'code generation', 'runtime requirements']:
                values = []
                for row in group:
                    message = passes(row).get(name, '')
                    match = re.search(r': ([0-9.]+) ms$', message)
                    if match: values.append(float(match[1]))
                cells.append(f'{statistics.median(values):.3f}' if values else 'N/A')
            emit('| ' + arm + ' | ' + scenario + ' | ' + ' | '.join(cells) + ' |')
    emit('\n### Initial reference bytes')
    emit('| Arm | Require references | Token bytes/reference | Raw ID bytes/reference | Initial JS bytes | Relative to deterministic |')
    emit('| --- | ---: | ---: | ---: | ---: | ---: |')
    base = median([r for r in rows if r['arm'] == 'deterministic' and r['scenario'] == 'initial'], 'totalJsBytes')
    for arm in arms:
        group = [r for r in rows if r['arm'] == arm and r['scenario'] == 'initial']
        size = median(group, 'totalJsBytes')
        emit(f"| {arm} | {median(group,'references'):g} | {median(group,'tokenBytesPerReference'):.6f} | {median(group,'idBytesPerReference'):.6f} | {size:g} | {(size/base-1)*100:+.4f}% |")
    emit('\n### Raw pass timing entries, trial zero')
    for arm in arms:
        for scenario in ['content-3', 'add10', 'add1000']:
            row = next(r for r in rows if r['arm'] == arm and r['trial'] == 0 and r['scenario'] == scenario)
            emit(arm + ' ' + scenario + ': ' + json.dumps(passes(row), sort_keys=True))
    # Preserve warning text once per arm, rather than suppressing the fallbacks.
    emit('\n### Rebuild warning messages')
    for arm in arms:
        row = next(r for r in rows if r['arm'] == arm and r['scenario'] == 'content-1')
        emit(arm + ': ' + json.dumps(row.get('warnings', [])))
    # Expose a raw entry if this package uses a different logger format.
    sample = next(r for r in rows if r['scenario'] == 'content-1')
    (target / 'sample-logging.json').write_text(json.dumps(sample.get('logging'), indent=2))

# This is a uniform-hash model, NOT measurements of the application.
# Count only unescaped require arguments; eval transport adds escaping overhead.
rng = random.Random(20261016)
models = {}
for arm, alphabet, minimum in [('hashed', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', 4), ('compact-hashed', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 1)]:
    occupied = set()
    lengths = collections.Counter()
    for i in range(73600):
        if arm == 'compact-hashed':
            full = rng.choice(alphabet[:52]) + ''.join(rng.choices(alphabet, k=10))
        else:
            full = ''.join(rng.choices(alphabet, k=24))
        n = minimum
        while full[:n] in occupied:
            n += 1
        occupied.add(full[:n])
        lengths[n] += 1
    models[arm] = {'modules': 73600, 'unweightedIDLengths': dict(lengths), 'meanQuotedTokenBytes': sum((n+2)*v for n,v in lengths.items()) / 73600}
models['deterministic'] = {'modules': 73600, 'range': 10000000, 'uniformMeanNumericDigits': (1*10 + sum(n*9*10**(n-1) for n in range(2,8))) / 10000000}
(root / 'data' / 'uniform-model.json').write_text(json.dumps(models, indent=2))
emit('\n## Uniform-hash size model at 73,600 modules (not application measurements)')
emit(json.dumps(models, sort_keys=True))
(root / 'data' / 'summary.md').write_text('\n'.join(lines) + '\n')
