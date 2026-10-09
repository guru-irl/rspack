import json
import os
from pathlib import Path
import re
import subprocess
import time

from residency import residency

RESULTS = Path(os.environ['RESULTS'])
ROOT = Path(os.environ['SLOW_ROOT'])
CACHE = ROOT / 'cache'
SEED = ROOT / 'seed'
DRIVER = Path(__file__).with_name('run.mjs').resolve()
ARMS = ['round4', 'round2', 'off']
RESULTS.mkdir(parents=True, exist_ok=True)


def command(args):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    with (RESULTS / 'commands.log').open('a') as output:
        output.write(f'{args!r}\n{result.stdout}\nexit={result.returncode}\n')
    if result.returncode:
        raise RuntimeError(f'command failed: {args!r}, exit={result.returncode}')
    return result.stdout


def set_delay(delay):
    command(['sync'])
    loop = (RESULTS / 'loop-device.txt').read_text().strip()
    sectors = (RESULTS / 'sectors.txt').read_text().strip()
    table = f'0 {sectors} delay {loop} 0 {delay} {loop} 0 0'
    command(['sudo', 'dmsetup', 'suspend', 'slow'])
    try:
        command(['sudo', 'dmsetup', 'reload', 'slow', '--table', table])
    finally:
        command(['sudo', 'dmsetup', 'resume', 'slow'])
    observed = command(['sudo', 'dmsetup', 'table', 'slow'])
    (RESULTS / f'dm-table-{delay}.txt').write_text(observed)
    (RESULTS / f'mount-{delay}.txt').write_text(command(['findmnt', '-T', str(ROOT), '-o', 'SOURCE,FSTYPE,OPTIONS']))


def proc_memory(pid):
    try:
        data = Path(f'/proc/{pid}/status').read_text()
    except FileNotFoundError:
        return None
    result = {}
    for key in ['RssAnon', 'VmHWM', 'VmRSS', 'VmSwap']:
        match = re.search(rf'^{key}:\s+(\d+)', data, re.M)
        if match:
            result[key] = int(match[1])
    return result or None


def device_stats():
    name = Path((RESULTS / 'mapper-device.txt').read_text().strip()).name
    return [int(value) for value in Path(f'/sys/block/{name}/stat').read_text().split()]


def run_process(label, arm, phase):
    env = dict(os.environ)
    env['CACHE_DIR'] = str(CACHE)
    env['NAPI_RS_NATIVE_LIBRARY_PATH'] = env['BINDING_ROUND2' if arm == 'round2' else 'BINDING_ROUND4']
    env.pop('RSPACK_DISABLE_CACHE_PREFETCH', None)
    if arm == 'off':
        env['RSPACK_DISABLE_CACHE_PREFETCH'] = '1'
    start_stat = device_stats()
    started = time.monotonic_ns()
    samples = []
    with (RESULTS / f'{label}.stdout.log').open('w') as stdout, (RESULTS / f'{label}.stderr.log').open('w') as stderr:
        process = subprocess.Popen(['node', str(DRIVER), phase], env=env, stdout=stdout, stderr=stderr)
        try:
            while True:
                memory = proc_memory(process.pid)
                if memory:
                    samples.append({'elapsedMs': (time.monotonic_ns() - started) / 1e6, **memory})
                pid, code, usage = os.wait4(process.pid, os.WNOHANG)
                if pid:
                    process.returncode = os.waitstatus_to_exitcode(code)
                    break
                if time.monotonic_ns() - started > 1200 * 1e9:
                    process.kill()
                    pid, code, usage = os.wait4(process.pid, 0)
                    process.returncode = os.waitstatus_to_exitcode(code)
                    raise RuntimeError(f'{label}: process timed out')
                time.sleep(0.1)
        finally:
            if process.returncode is None:
                process.kill()
                process.wait()
    ended = time.monotonic_ns()
    end_stat = device_stats()
    (RESULTS / f'{label}.memory.json').write_text(json.dumps(samples))
    if process.returncode:
        raise RuntimeError(f'{label}: process exit {process.returncode}; see raw logs')
    data = (RESULTS / f'{label}.stdout.log').read_text()
    lines = [line[len('RESULT '):] for line in data.splitlines() if line.startswith('RESULT ')]
    if len(lines) != 1:
        raise RuntimeError(f'{label}: expected exactly one RESULT')
    result = json.loads(lines[0])
    stderr = (RESULTS / f'{label}.stderr.log').read_text()
    prefetch = re.findall(r'Prefetched cache \((\d+) files, (\d+) bytes, (\d+) ms\)', stderr)
    result.update({
        'label': label, 'arm': arm, 'wallMs': (ended - started) / 1e6,
        'userMs': usage.ru_utime * 1000, 'systemMs': usage.ru_stime * 1000,
        'rssAnonPeakKiB': max([result['rssAnonEndKiB']] + [sample.get('RssAnon', 0) for sample in samples]),
        'vmHwmKiB': max([result['vmHwmKiB'], usage.ru_maxrss] + [sample.get('VmHWM', 0) for sample in samples]),
        'vmSwapPeakKiB': max(sample.get('VmSwap', 0) for sample in samples),
        'memorySamples': len(samples),
        'deviceStatBefore': start_stat, 'deviceStatAfter': end_stat,
        'readRequests': end_stat[0] - start_stat[0],
        'readMiB': (end_stat[2] - start_stat[2]) * 512 / 2**20,
        'prefetch': [{'files': int(a), 'bytes': int(b), 'ms': int(c)} for a, b, c in prefetch],
    })
    for key in ['buildMs', 'makeMs', 'rssAnonEndKiB', 'vmHwmKiB']:
        if not isinstance(result[key], (float, int)) or result[key] <= 0:
            raise RuntimeError(f'{label}: invalid {key}')
    if phase == 'warm':
        graph = int(os.environ['MODULES']) * 6 // 5 + 61
        if result['modules'] != graph or result['counts'] != {'buildModule': 0, 'stillValidModule': graph}:
            raise RuntimeError(f'{label}: invalid warm graph counts')
        if arm == 'off' and prefetch:
            raise RuntimeError(f'{label}: disabled arm logged prefetch')
    return result


def main():
    if os.environ['MODULES'] not in ['60000', '30000']:
        raise RuntimeError('unsupported module count')
    set_delay(0)
    command(['rm', '-rf', str(CACHE), str(SEED)])
    seed = run_process('seed', 'round4', 'seed')
    (RESULTS / 'seed.json').write_text(json.dumps(seed, indent=2))
    command(['sync'])
    command(['cp', '-a', str(CACHE), str(SEED)])
    from probe import probe
    probe(SEED, ROOT / 'probe', RESULTS / 'probe')
    selected = [p for p in SEED.rglob('*') if p.is_file() and p.suffix in ['.meta', '.sst']]
    selected_bytes = sum(p.stat().st_size for p in selected)
    advice_calls = sum((p.stat().st_size + 128*1024-1)//(128*1024) for p in selected)
    (RESULTS / 'advice-calls.json').write_text(json.dumps({'rangeKiB': 128, 'files': len(selected), 'bytes': selected_bytes, 'calls': advice_calls}))
    with (RESULTS / 'runs.jsonl').open('w') as output:
        for condition, delay in [('evicted', 0), ('evicted', 1), ('evicted', 3), ('cached', 0)]:
            set_delay(delay)
            arms = ARMS if condition == 'evicted' else ['round4', 'off', 'round2']
            for repetition in range(5):
                order = arms[repetition % 3:] + arms[:repetition % 3]
                for position, arm in enumerate(order):
                    label = f'{condition}-d{delay}-r{repetition + 1}-{arm}'
                    command(['rm', '-rf', str(CACHE)])
                    command(['cp', '-a', str(SEED), str(CACHE)])
                    command(['sync'])
                    if condition == 'evicted':
                        command(['sudo', 'sh', '-c', 'echo 3 > /proc/sys/vm/drop_caches'])
                    else:
                        for path in sorted(CACHE.rglob('*')):
                            if path.is_file():
                                with path.open('rb') as file:
                                    while file.read(1024*1024):
                                        pass
                    before = residency(CACHE)
                    (RESULTS / f'{label}.residency.json').write_text(json.dumps(before))
                    expected = 0 if condition == 'evicted' else 100
                    if before['percent'] != expected:
                        raise RuntimeError(f'{label}: cache is {before["percent"]}% resident, expected {expected}')
                    (RESULTS / f'{label}.meminfo.txt').write_text(Path('/proc/meminfo').read_text())
                    result = run_process(label, arm, 'warm')
                    if arm != 'off':
                        if len(result['prefetch']) != 1 or result['prefetch'][0]['files'] != len(selected) or result['prefetch'][0]['bytes'] != selected_bytes:
                            raise RuntimeError(f'{label}: incomplete prefetch')
                    result.update({'condition': condition, 'delayMs': delay, 'round': repetition + 1, 'position': position,
                                   'residencyPercent': before['percent'], 'cacheBytes': before['bytes'],
                                   'adviceCalls': advice_calls if arm == 'round4' else 0 if arm == 'off' else None})
                    output.write(json.dumps(result) + '\n')
                    output.flush()
                    print(json.dumps(result), flush=True)
                    command(['rm', '-rf', str(CACHE)])
    print('60 successful warm starts', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        (RESULTS / 'failure.txt').write_text(f'{type(error).__name__}: {error}\n')
        raise
