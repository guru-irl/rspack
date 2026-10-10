import hashlib
import json
import os
import pathlib
import platform
import resource
import shutil
import subprocess
import time

REPO = pathlib.Path.cwd()
HERE = REPO / 'scripts/newcache-parity'
RESULTS = REPO / 'results'
WORK = REPO / '.spider/scratch/parity'
WORK.mkdir(parents=True, exist_ok=True)
RESULTS.mkdir(exist_ok=True)
MODULES = int(os.environ['FIXTURE_MODULES'])
PAIR = os.environ['PAIR']
REPEATS = int(os.environ['REPEATS'])
ARMS = {'LN': ['L', 'N'], 'LP': ['L', 'P'], 'LL': ['L', 'L'], 'NN': ['N', 'N']}[PAIR]
PROJECT = WORK / 'project'
CACHE = PROJECT / 'cache'
PHASES = ['cold', 'warm', 'drop', 'watch1', 'watch5', 'idle', 'exit']
records = []
failures = []
started = time.monotonic()


def checked(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def generate():
    shutil.copyfile(HERE / 'gen.mjs', WORK / 'gen.mjs')
    checked(['node', str(WORK / 'gen.mjs'), str(MODULES)])


def remove(directory):
    if directory.exists():
        shutil.rmtree(directory)


def clone(source, destination):
    remove(destination)
    # macOS clonefile keeps seed preparation cheap without page-cache reads.
    if platform.system() == 'Darwin':
        checked(['cp', '-cR', str(source), str(destination)])
    else:
        checked(['cp', '-a', '--reflink=auto', str(source), str(destination)])


def drop_pages():
    if platform.system() == 'Linux':
        checked(['sync'])
        checked(['sudo', 'sysctl', 'vm.drop_caches=3'])
    else:
        checked(['sync'])
        checked(['sudo', 'purge'])


def sample(arm, phase, label, counted=False, no_resolver=False, profile=False):
    output = RESULTS / f'{label}.json'
    env = dict(os.environ, PROJECT=str(PROJECT),
               RSPACK_CORE=str(REPO / 'runtime' / ('next' if arm == 'P' else 'main') / 'packages/rspack/dist/index.js'),
               COUNT='1' if counted else '0', NO_RESOLVER='1' if no_resolver else '0')
    command = ['node', '--expose-gc', str(HERE / 'run.mjs'), arm, phase, str(output)]
    if profile:
        command = [os.environ.get('PERF_TOOL', 'perf'), 'record', '-F', '499', '-e', 'cpu-clock', '-o', str(RESULTS / f'{label}.perf.data'), '--'] + command
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    begin = time.monotonic()
    with (RESULTS / f'{label}.log').open('w') as log:
        proc = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if proc.returncode != 0 or not output.exists():
        failure = {'label': label, 'returncode': proc.returncode, 'output_exists': output.exists()}
        failures.append(failure)
        (RESULTS / 'failures.json').write_text(json.dumps(failures, indent=2))
        raise RuntimeError(f'Failed command, not a sample: {failure}')
    data = json.loads(output.read_text())
    data.update(label=label, host=os.environ['HOST'], fixture_sources=MODULES,
                process_exit={'wall_ms': (time.monotonic() - begin) * 1000,
                              'user_ms': (after.ru_utime - before.ru_utime) * 1000,
                              'sys_ms': (after.ru_stime - before.ru_stime) * 1000},
                load_before=os.getloadavg(), profile=profile)
    if not data['rounds'] or not data['cache_closed']['files']:
        raise RuntimeError(f'Incomplete build or empty persisted cache: {label}')
    output.write_text(json.dumps(data))
    print(json.dumps({'label': label, 'done_ms': data['rounds'][0]['timestamps']['done']['wall_ms'],
                      'modules': data['rounds'][0]['modules']}), flush=True)
    return data


def stash(destination):
    remove(destination)
    CACHE.rename(destination)


def restore(seed):
    clone(seed, CACHE)


metadata = {'host': os.environ['HOST'], 'uname': platform.uname()._asdict(), 'cpus': os.cpu_count(),
            'node': subprocess.check_output(['node', '--version'], text=True).strip(),
            'modules': MODULES, 'pair': PAIR, 'repeats': REPEATS,
            'generator_sha256': hashlib.sha256((HERE / 'gen.mjs').read_bytes()).hexdigest(),
            'runtime_main': json.loads(next((REPO / 'artifacts').glob('binding-*-main/build.json')).read_text()),
            'runtime_next': json.loads(next((REPO / 'artifacts').glob('binding-*-next/build.json')).read_text()),
            'timing_counts_separate': True}
for name, command in [('disk', ['df', '-h', '.']), ('memory', ['free', '-m'] if platform.system() == 'Linux' else ['sysctl', 'hw.memsize'])]:
    metadata[name] = subprocess.check_output(command, text=True)
(RESULTS / 'metadata.json').write_text(json.dumps(metadata, indent=2))
generate()
leaf = PROJECT / 'src/d0/m9.js'
original = leaf.read_bytes()
original_stat = leaf.stat()


def reset_leaf():
    leaf.write_bytes(original)
    os.utime(leaf, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

try:
    for rep in range(0 if os.environ.get('ATTRIBUTION_ONLY') == '1' else REPEATS):
        if time.monotonic() - started > 4.5 * 3600:
            raise RuntimeError('Budget exhausted before requested repetitions; preserve partial dataset')
        order = [0, 1] if rep % 2 == 0 else [1, 0]
        seeds = [WORK / f'seed-{i}' for i in range(2)]
        for phase in PHASES:
            pair_records = []
            for slot in order:
                arm = ARMS[slot]
                label = f'{PAIR}-r{rep + 1}-{phase}-s{slot}-{arm}'
                reset_leaf()
                remove(CACHE)
                remove(PROJECT / 'dist')
                if phase != 'cold':
                    restore(seeds[slot])
                if phase == 'drop':
                    drop_pages()
                data = sample(arm, phase, label)
                data.update(rep=rep + 1, slot=slot, pair=PAIR, measured=True)
                (RESULTS / f'{label}.json').write_text(json.dumps(data))
                records.append(data)
                pair_records.append(data)
                if phase == 'cold':
                    stash(seeds[slot])
            # This checks filenames and bytes, including every watch edit output.
            outputs = [[r['outputs'] for r in d['rounds']] for d in pair_records]
            if outputs[0] != outputs[1]:
                raise RuntimeError(f'Output parity failed: {PAIR} r{rep + 1} {phase}')
        for seed in seeds:
            remove(seed)

    # One separately counted cold/warm/watch process per distinct arm. Actual
    # factorize/resolve taps introduce bridge overhead, excluded from all timing samples.
    if PAIR in ('LN', 'LP'):
        for arm in dict.fromkeys(ARMS):
            reset_leaf()
            remove(CACHE)
            remove(PROJECT / 'dist')
            seed = sample(arm, 'cold', f'diagnostic-{arm}-cold', counted=True)
            warm = sample(arm, 'warm', f'diagnostic-{arm}-warm', counted=True)
            sample(arm, 'watch5', f'diagnostic-{arm}-watch5', counted=True)
            reset_leaf()
            remove(CACHE)
            sample(arm, 'cold', f'profile-seed-{arm}')
            if platform.system() == 'Linux':
                # Profile all warm arms, then use the measured largest gap in analysis.
                # Flat IP samples do not require release unwind tables.
                profile_seed = WORK / f'profile-seed-{arm}'
                stash(profile_seed)
                restore(profile_seed)
                data = sample(arm, 'warm', f'profile-{arm}-warm', profile=True)
                remove(CACHE)
                restore(profile_seed)
                drop_pages()
                sample(arm, 'drop', f'profile-{arm}-drop', profile=True)
                remove(profile_seed)
                binding = next((REPO / 'runtime' / ('next' if arm == 'P' else 'main') / 'crates/node_binding').glob('*.node'))
                symbols = next((REPO / 'artifacts').glob(f"binding-*-{'next' if arm == 'P' else 'main'}/symbols.node"))
                shutil.copyfile(symbols, binding)
                for profile_phase in ('warm', 'drop'):
                    with (RESULTS / f'profile-{arm}-{profile_phase}.txt').open('w') as out:
                        checked([os.environ.get('PERF_TOOL', 'perf'), 'report', '--stdio', '--no-children', '--sort', 'dso,symbol',
                                 '-i', str(RESULTS / f'profile-{arm}-{profile_phase}.perf.data')], stdout=out)
                    with (RESULTS / f'profile-{arm}-{profile_phase}.script').open('w') as out:
                        checked([os.environ.get('PERF_TOOL', 'perf'), 'script', '-F', 'time,period,dso,sym',
                                 '-i', str(RESULTS / f'profile-{arm}-{profile_phase}.perf.data')], stdout=out)
                # Restore the stripped measured runtime after symbolization.
                checked(['tar', '-xzf', str(next((REPO / 'artifacts').glob(f"binding-*-{'next' if arm == 'P' else 'main'}/runtime.tar.gz"))),
                         '-C', str(REPO / 'runtime' / ('next' if arm == 'P' else 'main'))])
        if PAIR in ('LN', 'LP'):
            reset_leaf()
            remove(CACHE)
            arm = 'N' if PAIR == 'LN' else 'P'
            sample(arm, 'cold', f'diagnostic-nores-{arm}-cold', no_resolver=True)
            sample(arm, 'warm', f'diagnostic-nores-{arm}-warm', no_resolver=True)
            sample(arm, 'idle', f'diagnostic-nores-{arm}-idle', no_resolver=True)
    (RESULTS / 'success.json').write_text(json.dumps({'samples': len(records), 'repeats': REPEATS, 'parity': True}))
except BaseException as error:
    failures.append({'error': repr(error)})
    (RESULTS / 'failures.json').write_text(json.dumps(failures, indent=2))
    raise
finally:
    (RESULTS / 'index.json').write_text(json.dumps([d['label'] for d in records]))
    # Generated run caches are disposable. Keep raw records and fixture identity.
    remove(CACHE)
    for seed in WORK.glob('seed-*'):
        remove(seed)
