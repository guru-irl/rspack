import json, os, re, select, shutil, subprocess, time
from pathlib import Path
from residency import residency

RESULTS = Path(os.environ['RESULTS'])
ROOT = Path(os.environ['SLOW_ROOT'])
CACHE, SEED = ROOT / 'cache', ROOT / 'seed'
ARMS = ['main', 'workers2', 'workers4', 'blocking32', 'A', 'B', 'AB']
CORES = len(os.sched_getaffinity(0))
SCRIPT = Path(__file__).with_name('run.mjs').resolve()

def command(args):
    subprocess.run(args, check=True)

def set_delay(delay):
    loop = (RESULTS / 'loop-device.txt').read_text().strip()
    sectors = (RESULTS / 'sectors.txt').read_text().strip()
    command(['sync'])
    command(['sudo', 'dmsetup', 'suspend', 'slow'])
    command(['sudo', 'dmsetup', 'reload', 'slow', '--table', f'0 {sectors} delay {loop} 0 {delay} {loop} 0 0'])
    command(['sudo', 'dmsetup', 'resume', 'slow'])

def sample(pid):
    status = Path(f'/proc/{pid}/status').read_text()
    fields = {k: int(v) for k, v in re.findall(r'^(VmRSS|VmHWM|VmSwap|RssAnon):\s+(\d+)', status, re.M)}
    threads = []
    for task in Path(f'/proc/{pid}/task').iterdir():
        try:
            stat = (task / 'stat').read_text()
            end = stat.rfind(')')
            parts = stat[end+2:].split()
            threads.append({'tid': int(task.name), 'name': stat[stat.find('(')+1:end], 'state': parts[0], 'start': parts[19]})
        except (FileNotFoundError, ProcessLookupError): pass
    return {**fields, 'threads': threads, 'ns': time.monotonic_ns(), 'unixNs': time.time_ns()}

def run(label, arm, phase):
    env = dict(os.environ, CACHE_DIR=str(CACHE), RSPACK_BINDING=str(Path('artifacts').resolve() / ('prototype.node' if arm in ['A','B','AB'] else 'main.node')))
    for key in ['TOKIO_WORKER_THREADS','RSPACK_BLOCKING_THREADS','BENCH_STORAGE_IO','BENCH_STORAGE_PREFETCH']: env.pop(key, None)
    if arm == 'workers2': env['TOKIO_WORKER_THREADS'] = str(CORES * 2)
    if arm == 'workers4': env['TOKIO_WORKER_THREADS'] = str(CORES * 4)
    if arm == 'blocking32': env['RSPACK_BLOCKING_THREADS'] = '32'
    if arm in ['A','AB']: env['BENCH_STORAGE_PREFETCH'] = '1'
    if arm in ['B','AB']: env['BENCH_STORAGE_IO'] = '1'
    samples = []
    out = RESULTS / f'{label}.stdout'
    err = RESULTS / f'{label}.stderr'
    before = device_stat()
    with out.open('w') as stdout, err.open('w') as stderr:
        p = subprocess.Popen(['node', str(SCRIPT), phase], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1)
        ready = False
        launch = time.monotonic_ns()
        while not ready:
            if time.monotonic_ns() - launch > 120 * 1e9: p.kill(); p.wait(); raise RuntimeError('READY timeout')
            if select.select([p.stdout], [], [], 1)[0]:
                line = p.stdout.readline(); stdout.write(line); stdout.flush()
                if line.strip() == 'READY': ready = True
                elif not line: p.wait(); raise RuntimeError('exited before READY')
        p.stdin.write('go\n'); p.stdin.flush(); p.stdin.close()
        start = time.monotonic_ns()
        lines = []
        while True:
            try: samples.append(sample(p.pid))
            except (FileNotFoundError, ProcessLookupError): pass
            if select.select([p.stdout], [], [], 0.05)[0]:
                line = p.stdout.readline()
                if line: stdout.write(line); stdout.flush(); lines.append(line)
            pid, code, usage = os.wait4(p.pid, os.WNOHANG)
            if pid:
                p.returncode = os.waitstatus_to_exitcode(code)
                lines += p.stdout.readlines()
                break
            if time.monotonic_ns() - start > 1800 * 1e9:
                p.kill(); p.wait(); raise RuntimeError(f'{label} timeout')
        text = ''.join(lines)
        stdout.write('\nDRAINED\n' + text); stdout.flush()
    (RESULTS / f'{label}.samples.json').write_text(json.dumps(samples))
    if p.returncode: raise RuntimeError(f'{label}: exit {p.returncode}')
    found = [json.loads(line[7:]) for line in text.splitlines() if line.startswith('RESULT ')]
    if len(found) != 1: raise RuntimeError(f'{label}: no unique RESULT')
    result = found[0]
    after = device_stat()
    storage = re.findall(r'^STORAGE_END (\S+) ([\d.]+) (\d+)', err.read_text(), re.M)
    starts = dict((scope, int(ns)) for scope, ns in re.findall(r'^STORAGE_START (\S+) (\d+)', err.read_text(), re.M))
    windows = [(starts[scope], int(end)) for scope, _, end in storage]
    blocked = {}
    for prior, current in zip(samples, samples[1:]):
        duration = sum(max(0, min(current['unixNs'], end) - max(prior['unixNs'], start)) for start, end in windows) / 1e6
        for thread in prior['threads']:
            if thread['state'] == 'D':
                key = f"{thread['name']}:{thread['tid']}:{thread['start']}"
                blocked[key] = blocked.get(key, 0) + duration
    storage = [(scope, ms) for scope, ms, _ in storage]
    result.update(label=label, arm=arm, peakKiB=max([result['hwmKiB'], usage.ru_maxrss] + [s.get('VmHWM',0) for s in samples]), anonPeakKiB=max([result['anonEndKiB']] + [s.get('RssAnon',0) for s in samples]), dStateMs=blocked, storage=storage, storageMs=sum(float(ms) for _, ms in storage), deviceBefore=before, deviceAfter=after, readRequests=after[0]-before[0], readMiB=(after[2]-before[2])/2048, cores=CORES, samples=len(samples))
    assert samples and result['swapKiB'] == 0 and all(s.get('VmSwap',0)==0 for s in samples)
    assert result['buildMs'] > 0 and result['storageMs'] > 0
    return result

def device_stat():
    device = Path((RESULTS / 'mapper-device.txt').read_text().strip()).name
    return list(map(int, Path(f'/sys/class/block/{device}/stat').read_text().split()))

def main():
    set_delay(0)
    for path in [CACHE,SEED]:
        if path.exists(): shutil.rmtree(path)
    seed = run('seed', 'main', 'seed')
    command(['sync']); shutil.copytree(CACHE,SEED,copy_function=shutil.copy2)
    packs = list(SEED.rglob('*.pack'))
    size = sum(p.stat().st_size for p in packs)
    (RESULTS/'seed.json').write_text(json.dumps(dict(seed, packBytes=size, packFiles=len(packs)), indent=2))
    if size < 1024**3: raise RuntimeError(f'fixture packs {size} bytes, below 1 GiB; do not measure')
    n = int(os.environ.get('REPEATS','5'))
    arms = os.environ.get('ARMS',','.join(ARMS)).split(',')
    with (RESULTS/'runs.jsonl').open('w') as output:
        for condition,delay in [('evicted',0),('evicted',2),('evicted',8),('cached',0)]:
            set_delay(delay)
            for repetition in range(n):
                order = arms[repetition % len(arms):] + arms[:repetition % len(arms)]
                if (repetition // len(arms)) % 2: order.reverse()
                for position,arm in enumerate(order):
                    label=f'{condition}-d{delay}-r{repetition+1}-{arm}'
                    shutil.rmtree(CACHE); shutil.copytree(SEED,CACHE,copy_function=shutil.copy2)
                    command(['sync'])
                    if condition=='evicted': command(['sudo','sh','-c','echo 3 > /proc/sys/vm/drop_caches'])
                    else:
                        for path in CACHE.rglob('*'):
                            if path.is_file():
                                with path.open('rb') as f:
                                    while f.read(1024*1024): pass
                    resident=residency(CACHE)
                    (RESULTS/f'{label}.residency.json').write_text(json.dumps(resident))
                    assert resident['percent'] == (0 if condition=='evicted' else 100)
                    row=run(label,arm,'warm')
                    assert row['hash']==seed['hash'] and row['counts']['build']==0
                    row.update(condition=condition,delayMs=delay,round=repetition+1,position=position,cacheBytes=resident['bytes'])
                    output.write(json.dumps(row)+'\n'); output.flush()
                    print(json.dumps({k:row[k] for k in ['label','buildMs','storageMs','peakKiB','rssEndKiB','readRequests']}),flush=True)
    shutil.rmtree(CACHE); shutil.rmtree(SEED)

if __name__=='__main__':
    try: main()
    except Exception as e:
        (RESULTS/'failure.txt').write_text(f'{type(e).__name__}: {e}\n'); raise
