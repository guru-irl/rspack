import hashlib
import json
import os
import pathlib
import statistics
import subprocess
import threading
import time

root = pathlib.Path.cwd()
results = root / 'results'
results.mkdir(exist_ok=True)
rows = []

def run(arm, variant, phase, tag, semi=False):
    env = os.environ.copy()
    if semi:
        env['NODE_OPTIONS'] = '--max-semi-space-size=64'
    else:
        env.pop('NODE_OPTIONS', None)
    name = f'{tag}-{variant}-{arm}-{phase}'
    process = subprocess.Popen(['node', '--expose-gc', 'run.mjs', arm, variant, phase, tag], stdout=subprocess.PIPE, stderr=(results / f'{name}.stderr.log').open('w'), text=True, env=env)
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
    result['series'] = 'semi64' if semi else 'default'
    rows.append(result)
    with (results / 'samples.jsonl').open('a') as out:
        out.write(json.dumps(result) + '\n')
    print(f"{name}: {result['wall_ms'] / 1000:.3f}s, {result['peak_anon_mib']:.1f} MiB, built={result['counts']['build']}, valid={result['counts']['valid']}", flush=True)
    return result

for rep in range(1, 6):
    variants = ['broad', 'narrow'] if rep % 2 else ['narrow', 'broad']
    arms = ['stock', 'patched', 'none'] if rep % 2 else ['none', 'patched', 'stock']
    for variant in variants:
        pair = {}
        for arm in arms:
            cold = run(arm, variant, 'cold', f'r{rep}')
            warm = run(arm, variant, 'warm', f'r{rep}')
            assert cold['output_sha256'] == warm['output_sha256'], 'Cold/warm output mismatch'
            assert cold['attachment_sha256'] == warm['attachment_sha256'], 'Cold/warm attachment mismatch'
            pair[arm] = cold, warm
        assert len({r['output_sha256'] for arm in arms for r in pair[arm]}) == 1, 'Cross-arm output mismatch'
        for phase_index in range(2):
            for field in ['counts', 'attachment_sha256', 'attached_modules']:
                left = pair['stock'][phase_index][field]
                right = pair['patched'][phase_index][field]
                assert left == right, f'Cross-arm work mismatch: {field}'
        # Remove only owned caches after their cold/warm pair has been recorded.
        import shutil
        for arm in arms:
            shutil.rmtree(root / 'cache' / f'{variant}-{arm}-r{rep}')

cold = {arm: [r for r in rows if r['variant'] == 'broad' and r['phase'] == 'cold' and r['arm'] == arm] for arm in ['stock', 'patched']}
deltas = [right['wall_ms'] - left['wall_ms'] for left, right in zip(cold['stock'], cold['patched'])]
anomaly = statistics.median(deltas) > 0
(results / 'probe-decision.json').write_text(json.dumps({'default_broad_cold_deltas_ms': deltas, 'anomaly_reproduced_by_median_sign': anomaly, 'rule': 'Run n=3 semi64 cold pairs if median patched-minus-stock wall is positive.'}, indent=2))
if anomaly:
    for rep in range(1, 4):
        arms = ['patched', 'stock'] if rep % 2 else ['stock', 'patched']
        pair = [run(arm, 'broad', 'cold', f'p{rep}', semi=True) for arm in arms]
        assert len({r['output_sha256'] for r in pair}) == 1
        assert pair[0]['counts'] == pair[1]['counts']
        assert pair[0]['attachment_sha256'] == pair[1]['attachment_sha256']
        for arm in arms:
            shutil.rmtree(root / 'cache' / f'broad-{arm}-p{rep}')
# Check measured package bytes and shared dependencies again after all runs.
manifest = json.loads((root / 'manifest.json').read_text())
for arm in ['stock', 'patched']:
    for item in manifest['files']:
        data = (root / 'variants' / arm / 'package' / item['path']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sha256_' + ('before' if arm == 'stock' else 'after')]
for name, digest in json.loads((results / 'dependency-hashes.json').read_text()):
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest
print('All output/work/cache/identity checks passed', flush=True)
