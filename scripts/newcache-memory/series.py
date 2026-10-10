import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import subprocess
import time

REPO = Path.cwd()
HERE = REPO / 'scripts/newcache-memory'
WORK = REPO / '.spider/scratch/memory'
RESULTS = REPO / 'results'
PROJECT = WORK / 'project'
CACHE = PROJECT / 'cache'
PHASE = os.environ['PHASE']
CANDIDATE = os.environ['CANDIDATE']
N = 20
for directory in (WORK, RESULTS):
    directory.mkdir(parents=True, exist_ok=True)
records = []

def checked(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)

def remove(directory):
    if directory.exists():
        shutil.rmtree(directory)

def clone(source, destination):
    remove(destination)
    checked(['cp', '-cR', str(source), str(destination)] if platform.system() == 'Darwin'
            else ['cp', '-a', '--reflink=auto', str(source), str(destination)])

def preread(directory):
    for file in directory.rglob('*'):
        if file.is_file():
            with file.open('rb') as stream:
                while stream.read(1024 * 1024):
                    pass

def drop():
    checked(['sync'])
    if platform.system() == 'Linux':
        checked(['sudo', 'sh', '-c', 'echo 3 > /proc/sys/vm/drop_caches'])
    else:
        checked(['sudo', 'purge'])

def sample(arm, phase, label):
    output = RESULTS / f'{label}.json'
    env = dict(os.environ, PROJECT=str(PROJECT),
               NODE_PATH=str(REPO / 'runtime' / arm / 'node_modules'),
               RSPACK_CORE=str(REPO / 'runtime' / arm / 'packages/rspack/dist/index.js'))
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    with (RESULTS / f'{label}.log').open('w') as log:
        proc = subprocess.run(['node', '--expose-gc', str(HERE / 'run.mjs'), arm, phase, str(output)],
                              env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if proc.returncode or not output.exists():
        raise RuntimeError(f'Failed command, not a sample: {label}, exit {proc.returncode}')
    data = json.loads(output.read_text())
    expected = 7 if phase == 'watch' else 2 if phase == 'edit' else 1
    if len(data['rounds']) != expected or data['rounds'][0]['modules'] < 60000:
        raise RuntimeError(f'Incomplete fixture/build count: {label}')
    data.update(label=label, exit_wall_ms=(time.monotonic() - started) * 1000,
                exit_cpu_ms=(after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime) * 1000,
                exit_maxrss=after.ru_maxrss)
    output.write_text(json.dumps(data))
    print(json.dumps({'label': label, 'done': data['rounds'][0]['done'],
                      'peak': data['memory_closed']['peak']}), flush=True)
    return data

try:
    shutil.copyfile(HERE / 'gen.mjs', WORK / 'gen.mjs')
    checked(['node', str(WORK / 'gen.mjs'), '60000'])
    leaf = PROJECT / 'src/d0/m9.js'
    original = leaf.read_bytes()
    stat = leaf.stat()
    def reset_leaf():
        leaf.write_bytes(original)
        os.utime(leaf, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    metadata = {'platform': platform.uname()._asdict(), 'phase': PHASE, 'candidate': CANDIDATE,
                'n': N, 'generator_sha256': hashlib.sha256((HERE / 'gen.mjs').read_bytes()).hexdigest(),
                'node': subprocess.check_output(['node', '--version'], text=True).strip(),
                'cpus': os.cpu_count(), 'memory_delta_margin_bytes': 8 * 1024 * 1024,
                'aa_pairs': 20, 'ab_pairs': 20}
    (RESULTS / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    seeds = {}
    for arm in ('main', CANDIDATE):
        reset_leaf()
        remove(CACHE)
        remove(PROJECT / 'dist')
        data = sample(arm, 'seed', f'seed-{arm}')
        seed = WORK / f'seed-{arm}'
        remove(seed)
        CACHE.rename(seed)
        seeds[arm] = seed
        if arm == 'main':
            baseline_output = data['rounds'][0]['outputs']
        elif data['rounds'][0]['outputs'] != baseline_output:
            raise RuntimeError('Cold output parity failed')
    # Fixed schedule before any outcome is known. Alternate experiment blocks and AB/BA order.
    for pair in range(N):
        for comparison in ('AA', 'AB') if pair % 2 == 0 else ('AB', 'AA'):
            arms = ('main', 'main') if comparison == 'AA' else ('main', CANDIDATE)
            paired = {}
            for slot in (0, 1) if pair % 2 == 0 else (1, 0):
                arm = arms[slot]
                reset_leaf()
                clone(seeds[arm], CACHE)
                remove(PROJECT / 'dist')
                if PHASE == 'drop':
                    drop()
                else:
                    preread(PROJECT / 'src')
                    preread(PROJECT / 'node_modules')
                    preread(CACHE)
                data = sample(arm, PHASE, f'{comparison}-{pair + 1}-{slot}-{arm}')
                data.update(pair=pair + 1, comparison=comparison, slot=slot)
                (RESULTS / f'{data["label"]}.json').write_text(json.dumps(data))
                paired[slot] = data
            if [r['outputs'] for r in paired[0]['rounds']] != [r['outputs'] for r in paired[1]['rounds']]:
                raise RuntimeError(f'Paired output parity failed: {comparison} {pair + 1}')
            if paired[0]['rounds'][0]['outputs'] != baseline_output:
                raise RuntimeError('Warm versus cold output parity failed')
            records.extend(paired.values())
    (RESULTS / 'success.json').write_text(json.dumps({'aa_pairs': N, 'ab_pairs': N, 'parity': True}))
except BaseException as error:
    (RESULTS / 'failure.json').write_text(json.dumps({'error': repr(error), 'accepted_records': len(records)}))
    raise
finally:
    (RESULTS / 'index.json').write_text(json.dumps([d['label'] for d in records]))
    remove(CACHE)
    for seed in WORK.glob('seed-*'):
        remove(seed)
