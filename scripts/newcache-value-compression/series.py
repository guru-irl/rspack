import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import statistics

ROOT = Path.cwd()
HERE = ROOT / 'scripts/newcache-value-compression'
WORK = ROOT / '.spider/scratch/sanity'
PROJECT = WORK / 'project'
RESULTS = ROOT / 'results'
WORK.mkdir(parents=True, exist_ok=True)
RESULTS.mkdir(exist_ok=True)

def remove(p):
    if p.exists():
        shutil.rmtree(p)

def clone(source, dest):
    remove(dest)
    subprocess.run(['cp', '-cR', str(source), str(dest)] if platform.system() == 'Darwin'
                   else ['cp', '-a', '--reflink=auto', str(source), str(dest)], check=True)

def preread(p):
    for f in p.rglob('*'):
        if f.is_file():
            with f.open('rb') as stream:
                while stream.read(1024 * 1024):
                    pass

def sample(arm, phase, label):
    output = RESULTS / f'{label}.json'
    env = dict(os.environ, PROJECT=str(PROJECT),
               NODE_PATH=str(ROOT / 'runtime' / arm / 'node_modules'),
               RSPACK_CORE=str(ROOT / 'runtime' / arm / 'packages/rspack/dist/index.js'))
    with (RESULTS / f'{label}.log').open('w') as log:
        subprocess.run(['node', '--expose-gc', str(HERE / 'run.mjs'), arm, phase, str(output)],
                       env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1200)
    data = json.loads(output.read_text())
    if len(data['rounds']) != 1 or data['rounds'][0]['modules'] != 72061:
        raise RuntimeError(f'Wrong module/build count: {label}')
    if not data.get('memory_exit'):
        raise RuntimeError(f'Missing final counters: {label}')
    return data

try:
    shutil.copyfile(HERE / 'gen.mjs', WORK / 'gen.mjs')
    subprocess.run(['node', str(WORK / 'gen.mjs'), '60000'], check=True)
    seeds = {}
    manifests = []
    for arm in ('main', 'branch'):
        remove(PROJECT / 'cache')
        remove(PROJECT / 'dist')
        data = sample(arm, 'seed', f'seed-{arm}')
        manifests.append(data['rounds'][0]['outputs'])
        seed = WORK / f'seed-{arm}'
        remove(seed)
        (PROJECT / 'cache').rename(seed)
        seeds[arm] = seed
    if manifests[0] != manifests[1]:
        raise RuntimeError('Cold output mismatch')
    pairs = []
    for pair in range(5):
        records = {}
        order = ('main', 'branch') if pair % 2 == 0 else ('branch', 'main')
        for arm in order:
            clone(seeds[arm], PROJECT / 'cache')
            remove(PROJECT / 'dist')
            for p in (PROJECT / 'src', PROJECT / 'node_modules', PROJECT / 'cache'):
                preread(p)
            data = sample(arm, 'warm', f'pair-{pair+1}-{arm}')
            if data['rounds'][0]['outputs'] != manifests[0]:
                raise RuntimeError('Warm output mismatch')
            records[arm] = data
        pairs.append({'pair': pair + 1, 'order': order, 'records': records})
    is_mac = platform.system() == 'Darwin'
    metrics = {
        'wall_ms': lambda d: d['rounds'][0]['done']['wall_ms'],
        'done_mib': lambda d: d['rounds'][0]['memory_done']['phys_footprint' if is_mac else 'RssAnon'] / 1048576,
        'peak_mib': lambda d: d['rounds'][0]['memory_done']['peak' if is_mac else 'sampled_RssAnon_peak'] / 1048576,
    }
    summary = {}
    for metric, getter in metrics.items():
        a = [getter(p['records']['main']) for p in pairs]
        b = [getter(p['records']['branch']) for p in pairs]
        summary[metric] = {'main': statistics.mean(a), 'branch': statistics.mean(b),
                           'paired_delta': statistics.mean(y-x for x,y in zip(a,b)),
                           'main_values': a, 'branch_values': b}
    report = {'n': 5, 'kind': 'warm-start sanity only, no settled-retention claim',
              'platform': platform.uname()._asdict(), 'node': subprocess.check_output(['node','--version'],text=True).strip(),
              'generator_sha256': hashlib.sha256((HERE/'gen.mjs').read_bytes()).hexdigest(),
              'module_count': 72061, 'parity': True, 'metrics': summary}
    (RESULTS/'sanity.json').write_text(json.dumps(report, indent=2))
    (RESULTS/'pairs.json').write_text(json.dumps(pairs))
    lines = ['| Platform | Arm | Wall (ms) | Done memory (MiB) | Warm peak memory (MiB) |', '|---|---|---:|---:|---:|']
    for arm in ('main','branch'):
        lines.append(f'| {platform.system()} | {arm} | {summary["wall_ms"][arm]:.2f} | {summary["done_mib"][arm]:.2f} | {summary["peak_mib"][arm]:.2f} |')
    (RESULTS/'summary.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(report, indent=2))
finally:
    remove(PROJECT / 'cache')
    for seed in WORK.glob('seed-*'):
        remove(seed)
