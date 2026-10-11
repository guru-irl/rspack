import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

from residency import residency

HERE = Path(__file__).resolve().parent
WORK = Path.cwd()
RESULTS = WORK / 'results'
RESULTS.mkdir(exist_ok=True)
SYSTEM = platform.system()
STUDY_START = time.monotonic()
STUDY_LIMIT = 105 * 60
FIXTURE = WORK / ('slow-mount/fixture' if SYSTEM == 'Linux' else 'fixture')
OUTPUT = WORK / '.spider/scratch/output'
CORE_ROOT = WORK / '.spider/scratch/deps'
RESULTS.joinpath('environment.json').write_text(json.dumps({
    'platform': platform.platform(), 'cpuCount': os.cpu_count(), 'python': sys.version,
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'ImageOS': os.environ.get('ImageOS'), 'ImageVersion': os.environ.get('ImageVersion'),
    'sha': os.environ.get('GITHUB_SHA'), 'runner': os.environ.get('RUNNER_NAME')
}, indent=2))


def command(argv):
    return subprocess.check_output(argv, text=True).strip()


def linux_fields(pid):
    text = Path(f'/proc/{pid}/status').read_text()
    fields = {}
    for line in text.splitlines():
        key, _, value = line.partition(':')
        if key in ['VmHWM', 'VmRSS', 'RssAnon', 'VmSwap', 'Threads']:
            fields[key] = int(value.split()[0]) * (1 if key == 'Threads' else 1024)
    return fields


def set_delay(delay):
    loop = RESULTS.joinpath('loop-device.txt').read_text().strip()
    sectors = RESULTS.joinpath('sectors.txt').read_text().strip()
    subprocess.run(['sudo', 'dmsetup', 'suspend', 'slow'], check=True)
    subprocess.run(['sudo', 'dmsetup', 'reload', 'slow', '--table', f'0 {sectors} delay {loop} 0 {delay} {loop} 0 0'], check=True)
    subprocess.run(['sudo', 'dmsetup', 'resume', 'slow'], check=True)
    RESULTS.joinpath(f'dm-table-{delay}.txt').write_text(command(['sudo', 'dmsetup', 'table', 'slow']) + '\n')


def digest_output():
    h = hashlib.sha256()
    for file in sorted(OUTPUT.rglob('*')):
        if file.is_file():
            h.update(file.relative_to(OUTPUT).as_posix().encode())
            with file.open('rb') as f:
                for block in iter(lambda: f.read(1024 * 1024), b''):
                    h.update(block)
    return h.hexdigest()


def launch(cell, variant, arm, round_number, measured=True):
    if time.monotonic() - STUDY_START > STUDY_LIMIT - 60:
        raise RuntimeError('ESCALATION: study budget exhausted')
    ident = f'{variant}-{cell}-{round_number}-{arm}'
    if not measured:
        ident = 'conditioning-' + ident
    out = RESULTS / ident
    out.mkdir()
    shutil.rmtree(OUTPUT, ignore_errors=True)
    OUTPUT.mkdir(parents=True)
    cold = None
    if SYSTEM == 'Linux':
        subprocess.run(['sync'], check=True)
        subprocess.run(['sudo', 'sh', '-c', 'echo 3 > /proc/sys/vm/drop_caches'], check=True)
        cold = residency(FIXTURE)
        out.joinpath('residency.json').write_text(json.dumps(cold))
        if cold['resident'] != 0:
            raise RuntimeError('ESCALATION: nonzero fixture residency')
        out.joinpath('meminfo-before.txt').write_text(Path('/proc/meminfo').read_text())
    elif cell == 'purge-cold':
        subprocess.run(['sudo', 'purge'], check=True)
    env = dict(os.environ, CORE_ROOT=str(CORE_ROOT), FIXTURE=str(FIXTURE), OUTPUT=str(OUTPUT),
               VARIANT=variant, DRIVER_RESULT=str(out / 'driver.json'))
    # Do not inherit an experimental binding or other Rspack pool overrides.
    for key in ['RSPACK_BLOCKING_THREADS', 'NAPI_RS_NATIVE_LIBRARY_PATH', 'RSPACK_THREADS', 'RAYON_NUM_THREADS']:
        env.pop(key, None)
    if arm != 'unset':
        env['RSPACK_BLOCKING_THREADS'] = arm
    stdout = out.joinpath('stdout.txt').open('w')
    stderr = out.joinpath('stderr.txt').open('w')
    proc = subprocess.Popen(['node', str(HERE / 'run.mjs')], env=env, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr)
    monitor = None
    external = []
    started = time.monotonic()
    try:
        # Runtime is initialized, but run() waits for the sampler before starting.
        while '"ready":true' not in out.joinpath('stdout.txt').read_text():
            if proc.poll() is not None or time.monotonic() - started > 60:
                raise RuntimeError('driver did not become ready')
            time.sleep(0.1)
        if SYSTEM == 'Windows':
            monitor = subprocess.Popen(['pwsh', '-NoProfile', '-File', str(HERE / 'threads.ps1'),
                                        '-TargetPid', str(proc.pid), '-OutFile', str(out / 'threads.jsonl')],
                                       stdout=stdout, stderr=stderr)
            while not out.joinpath('threads.jsonl').exists() or not out.joinpath('threads.jsonl').stat().st_size:
                if monitor.poll() is not None or time.monotonic() - started > 60:
                    raise RuntimeError('thread sampler did not become ready')
                time.sleep(0.1)
        proc.stdin.write(b'start\n')
        proc.stdin.flush()
        proc.stdin.close()
        while proc.poll() is None:
            at = time.time() * 1000
            if SYSTEM == 'Linux':
                try:
                    fields = linux_fields(proc.pid)
                    external.append(dict(at=at, **fields))
                except FileNotFoundError:
                    pass
            elif SYSTEM == 'Darwin':
                ps = subprocess.run(['ps', '-M', '-p', str(proc.pid)], text=True, capture_output=True)
                if ps.returncode == 0:
                    external.append({'at': at, 'Threads': len(ps.stdout.strip().splitlines()) - 1})
            if time.monotonic() - started > 900:
                raise RuntimeError('launch deadline exceeded')
            time.sleep(0.1)
        if proc.returncode != 0:
            raise RuntimeError(f'driver exited {proc.returncode}')
    except Exception as err:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        out.joinpath('failure.txt').write_text(str(err))
        RESULTS.joinpath('failures.jsonl').open('a').write(json.dumps({'id': ident, 'error': str(err)}) + '\n')
        raise RuntimeError(f'ESCALATION: launch failed: {ident}: {err}') from err
    finally:
        if monitor:
            try:
                monitor.wait(timeout=10)
            except subprocess.TimeoutExpired:
                monitor.kill()
                monitor.wait()
        stdout.close()
        stderr.close()
    if SYSTEM == 'Windows':
        external = [{'at': row['at'], 'Threads': row['threads']} for row in
                    (json.loads(line) for line in out.joinpath('threads.jsonl').read_text().splitlines())]
    out.joinpath('external-samples.json').write_text(json.dumps(external))
    driver = json.loads(out.joinpath('driver.json').read_text())
    assert driver['env'] == (None if arm == 'unset' else arm)
    assert len(driver['samples']) >= 120
    assert driver['end12']['atMs'] - driver['end0']['atMs'] >= 12000
    row = {'id': ident, 'system': SYSTEM, 'cell': cell, 'variant': variant, 'arm': arm, 'round': round_number,
           'measured': measured, 'wallMs': driver['wallMs'], 'cpuMs': driver['cpuMs'],
           'cpuUserMs': driver['cpuUserMs'], 'cpuSysMs': driver['cpuSysMs'],
           'statsTimes': driver['statsTimes'], 'makes': driver['makes'], 'outputHash': digest_output(),
           'peakRSS': max(s['rss'] for s in driver['samples']),
           'end0RSS': driver['end0']['rss'], 'end12RSS': driver['end12']['rss'],
           'maxThreads': max(s['Threads'] for s in external),
           'beforeThreads': external[0]['Threads'], 'externalSampleCount': len(external),
           'driverSampleCount': len(driver['samples'])}
    if SYSTEM == 'Linux':
        memory_samples = external + driver['samples']
        for metric in ['VmHWM', 'RssAnon', 'VmSwap']:
            row['peak' + metric] = max(s.get(metric, 0) for s in memory_samples)
        for phase in ['end0', 'end12']:
            for metric in ['VmRSS', 'RssAnon', 'Threads']:
                row[phase + metric] = driver[phase][metric]
        row['peakRSS'] = row['peakVmHWM']
        row['residency'] = {k: v for k, v in cold.items() if k != 'details'}
    with RESULTS.joinpath('all-launches.jsonl').open('a') as f:
        f.write(json.dumps(row) + '\n')
    if measured:
        with RESULTS.joinpath('runs.jsonl').open('a') as f:
            f.write(json.dumps(row) + '\n')
    print(json.dumps(row), flush=True)
    return row


if SYSTEM == 'Linux':
    # Same cp -a, loop/DIO/dm-delay/ext4 stack as the previous study.
    subprocess.run(['cp', '-a', str(WORK / 'fixture'), str(FIXTURE)], check=True)
    cells = [('cold-0ms', 5, 0), ('cold-2ms', 5, 2), ('cold-8ms', 5, 8)]
elif SYSTEM == 'Darwin':
    cells = [('warm', 5, None), ('purge-cold', 3, None)]
else:
    cells = [('warm', 5, None)]

for variant in ['single', 'multi']:
    for cell, n, delay in cells:
        if delay is not None:
            set_delay(delay)
        elif cell == 'warm':
            launch(cell, variant, 'unset', 0, measured=False)
        rows = []
        for round_number in range(1, n + 1):
            if round_number == 5 and rows:
                # Preserve complete paired rounds. Estimate from this cell's
                # observed launches, allowing a 2x margin and the reference.
                elapsed = time.monotonic() - STUDY_START
                estimated = 2 * sum(r['wallMs'] / 1000 + 15 for r in rows[-3:]) + 60
                if elapsed + estimated > STUDY_LIMIT:
                    RESULTS.joinpath(f'reduced-n-{variant}-{cell}.txt').write_text('n=4: fifth round omitted to stay below two-hour job limit\n')
                    break
            arms = ['unset', '16', '64']
            shift = (round_number - 1) % 3
            for arm in arms[shift:] + arms[:shift]:
                rows.append(launch(cell, variant, arm, round_number))
        rows.append(launch(cell, variant, '512', 1))
        counts = {arm: max(r['maxThreads'] for r in rows if r['arm'] == arm) for arm in ['unset', '16', '64', '512']}
        # A cap is lazy, not a preallocated count. A strictly increasing observed
        # count for 4,16,64 is required to establish that the override took effect.
        if not counts['unset'] < counts['16'] < counts['64']:
            raise RuntimeError(f'ESCALATION: env effect not established in {variant}/{cell}: {counts}')
        if len({r['outputHash'] for r in rows}) != 1:
            raise RuntimeError(f'ESCALATION: output mismatch in {variant}/{cell}')
        RESULTS.joinpath(f'verified-{variant}-{cell}.json').write_text(json.dumps({'threadCounts': counts, 'outputHash': rows[0]['outputHash']}))
