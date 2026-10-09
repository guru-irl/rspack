import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import threading
import time

root = pathlib.Path.cwd()
results = root / 'results'
results.mkdir(exist_ok=True)
rows = []
arms = ['U0', 'U1', 'U2', 'RX']

def run(arm, variant, phase, tag, control=False):
    env = os.environ.copy()
    env.pop('NODE_OPTIONS', None)
    name = f'{tag}-{variant}-{arm}-{phase}'
    command = ['node', '--expose-gc', 'run.mjs', arm, variant, phase, tag]
    if control:
        command.append('gc')
    with (results / f'{name}.stderr.log').open('w') as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True, env=env)
        active = threading.Event()
        stop = threading.Event()
        readings = []
        def sample():
            next_at = time.monotonic()
            while not stop.is_set():
                if active.is_set():
                    try:
                        text = pathlib.Path(f'/proc/{process.pid}/status').read_text()
                        value = next(float(line.split()[1]) / 1024 for line in text.splitlines() if line.startswith('RssAnon:'))
                        readings.append([time.monotonic(), value])
                    except (FileNotFoundError, ProcessLookupError, StopIteration, PermissionError):
                        pass
                next_at += .01
                stop.wait(max(0, next_at - time.monotonic()))
        thread = threading.Thread(target=sample)
        thread.start()
        result = None
        with (results / f'{name}.stdout.log').open('w') as log:
            for line in process.stdout:
                log.write(line)
                if not line.startswith('{'):
                    continue
                event = json.loads(line)
                if event['event'] == 'start':
                    active.set()
                elif event['event'] == 'endpoint':
                    active.clear()
                elif event['event'] == 'result':
                    result = event
        rc = process.wait()
        stop.set()
        thread.join()
    if rc != 0 or result is None:
        raise RuntimeError(f'{name}: failed process {rc}; see stderr log')
    assert readings, 'RSS sampler did not record samples'
    result['peak_anon_mib'] = max(result['end_anon_mib'], max(r[1] for r in readings))
    result['rss_sample_count'] = len(readings)
    result['rss_samples'] = [[(t - readings[0][0]) * 1000, v] for t, v in readings]
    result['series'] = 'gc-control' if control else 'default'
    rows.append(result)
    with (results / 'samples.jsonl').open('a') as out:
        out.write(json.dumps(result) + '\n')
    print(f"{name}: {result['wall_ms'] / 1000:.3f}s, {result['peak_anon_mib']:.1f} MiB, built={result['counts']['build']}, valid={result['counts']['valid']}", flush=True)
    return result

def repeat(rep, control=False):
    tag = f'g{rep}' if control else f'r{rep}'
    variants = ['broad', 'narrow'] if rep % 2 else ['narrow', 'broad']
    orders = [arms, ['U1', 'RX', 'U0', 'U2'], ['U2', 'U0', 'RX', 'U1'], ['RX', 'U2', 'U1', 'U0'], list(reversed(arms))]
    order = orders[(rep - 1) % len(orders)]
    for variant in variants:
        pairs = {}
        for arm in order:
            cold = run(arm, variant, 'cold', tag, control)
            warm = run(arm, variant, 'warm', tag, control)
            assert cold['output_sha256'] == warm['output_sha256'], 'Cold/warm output mismatch'
            assert cold['attachment_sha256'] == warm['attachment_sha256'], 'Cold/warm attachment mismatch'
            pairs[arm] = cold, warm
            shutil.rmtree(root / 'cache' / f'{variant}-{arm}-{tag}')
        assert len({r['output_sha256'] for pair in pairs.values() for r in pair}) == 1, 'Cross-arm output mismatch'
        for phase_index in range(2):
            for field in ['counts', 'attachment_sha256', 'attached_modules']:
                assert all(pairs[arm][phase_index][field] == pairs['U0'][phase_index][field] for arm in arms), f'Cross-arm work mismatch: {field}'
            for kind in ['transform', 'load']:
                for field in ['started', 'completed']:
                    assert len({pairs[arm][phase_index]['loader'][field][kind] for arm in arms}) == 1

for rep in range(1, 6):
    repeat(rep)
# One additional cold/warm process pair per arm/variant. Not a timing sample.
repeat(1, control=True)
assert len(rows) == 96
assert len({r['output_sha256'] for r in rows}) == 1
assert all(r.get('post_gc') is None for r in rows if r['series'] == 'default')
for arm, files in json.loads((results / 'arm-hashes.json').read_text()).items():
    for name, digest in files.items():
        assert hashlib.sha256((root / 'variants' / arm / 'package' / name).read_bytes()).hexdigest() == digest
for name, digest in json.loads((results / 'dependency-hashes.json').read_text()):
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest
(results / 'parity.json').write_text(json.dumps({'timing_runs': 80, 'excluded_gc_runs': 16, 'output_sha256': rows[0]['output_sha256'], 'output_bytes_identical': True, 'call_counts_identical': True, 'stable_plugin_and_hook_identity': True, 'all_integrity_checks_passed': True}, indent=2))
print('All output/work/cache/identity checks passed', flush=True)
