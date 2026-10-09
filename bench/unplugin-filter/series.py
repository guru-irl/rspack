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
arms = ['U0', 'U2r2', 'RX']

def run(arm, variant, phase, tag, control=False, flags=(), series=None):
    env = os.environ.copy()
    env.pop('NODE_OPTIONS', None)
    name = f'{tag}-{variant}-{arm}-{phase}'
    command = ['node', '--expose-gc', *flags, 'run.mjs', arm, variant, phase, tag]
    if control:
        command.append(control if isinstance(control, str) else 'gc')
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
    result['series'] = series or ('gc-control' if control else 'default')
    rows.append(result)
    with (results / 'samples.jsonl').open('a') as out:
        out.write(json.dumps(result) + '\n')
    print(f"{name}: {result['wall_ms'] / 1000:.3f}s, {result['peak_anon_mib']:.1f} MiB, built={result['counts']['build']}, valid={result['counts']['valid']}", flush=True)
    return result

def repeat(rep, control=False):
    tag = f'g{rep}' if control else f'r{rep}'
    variants = ['broad', 'narrow'] if rep % 2 else ['narrow', 'broad']
    orders = [arms, ['U2r2', 'RX', 'U0'], ['RX', 'U0', 'U2r2'], list(reversed(arms)), ['U0', 'RX', 'U2r2']]
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

def verify_hashes():
    for arm, files in json.loads((results / 'arm-hashes.json').read_text()).items():
        for name, digest in files.items():
            assert hashlib.sha256((root / 'variants' / arm / 'package' / name).read_bytes()).hexdigest() == digest
    for name, digest in json.loads((results / 'dependency-hashes.json').read_text()):
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest

if __name__ == '__main__':
    for rep in range(1, 6):
        repeat(rep)
    # Excluded default-generation controls, not timing samples.
    repeat(1, control=True)
    assert len(rows) == 72
    assert len({r['output_sha256'] for r in rows}) == 1
    assert all(r.get('post_gc') is None for r in rows if r['series'] == 'default')
    resolve = [run(arm, 'broad', 'cold', 'resolve', control='resolve', series='resolve-control') for arm in ['U0', 'U2r2']]
    assert resolve[0]['resolve_handler_calls'] == resolve[1]['resolve_handler_calls'] > 0
    assert resolve[0]['resolve_filter_reads'] > 1 and resolve[1]['resolve_filter_reads'] == 1
    assert resolve[0]['output_sha256'] == resolve[1]['output_sha256'] == rows[0]['output_sha256']
    for arm in ['U0', 'U2r2']:
        shutil.rmtree(root / 'cache' / f'broad-{arm}-resolve')
    (results / 'resolve-counts.json').write_text(json.dumps([{k: r[k] for k in ['arm', 'resolve_filter_reads', 'resolve_handler_calls', 'output_sha256']} for r in resolve], indent=2))
    verify_hashes()
    (results / 'parity.json').write_text(json.dumps({'timing_runs': 60, 'excluded_gc_runs': 12, 'excluded_resolve_runs': 2, 'output_sha256': rows[0]['output_sha256'], 'output_bytes_identical': True, 'call_counts_identical': True, 'stable_plugin_and_hook_identity': True, 'all_integrity_checks_passed': True}, indent=2))
    print('All output/work/cache/identity checks passed', flush=True)
