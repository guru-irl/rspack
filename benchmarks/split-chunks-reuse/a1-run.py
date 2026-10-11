import argparse, hashlib, json, os, pathlib, shutil, subprocess, sys, time
import psutil

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['timing', 'memory'])
args = parser.parse_args()
workspace = pathlib.Path(os.environ['GITHUB_WORKSPACE'])
here = workspace / 'benchmarks/split-chunks-reuse'
results = workspace / '.spider/scratch/split-chunks-name-once' / args.mode
results.mkdir(parents=True, exist_ok=True)
scratch = results.parent / 'tmp'
scratch.mkdir(exist_ok=True)
os.environ.update(TMPDIR=str(scratch), TMP=str(scratch), TEMP=str(scratch))
(results / 'host.json').write_text(json.dumps({'platform': sys.platform, 'cpuCount': os.cpu_count(), 'cpu': psutil.cpu_freq()._asdict() if psutil.cpu_freq() else None, 'memory': psutil.virtual_memory()._asdict(), 'image': os.environ.get('ImageVersion')}, indent=2))
core = here / 'node_modules/@rspack/core'
binding = here / 'node_modules/@rspack/binding'
sequence = []
for block in range(1, 6):
    if args.mode == 'timing':
        arms = [('C', 'main', 'js'), ('CA1', 'main-a1', 'js'), ('D', 'batch', 'js'), ('DA1', 'batch-a1', 'js'), ('C2', 'main', 'native-only'), ('C2A1', 'main-a1', 'native-only')]
        if block % 2 == 0:
            arms.reverse()
        sequence.extend((block, *arm) for arm in arms)
    else:
        # A/A and A/B have identical process and edit counts. Alternate both
        # pair order and within-pair direction, rather than compare hosts.
        pairs = [('AA-left', 'main'), ('AA-right', 'main'), ('A', 'main'), ('B', 'main-a1')]
        if block % 2 == 0:
            pairs.reverse()
        sequence.extend((block, label, build, 'js') for label, build in pairs)
for block, arm, build, policy in sequence:
    source = workspace / 'source-artifacts' / build
    for directory in ['dist', 'compiled']:
        destination = core / directory
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source / 'core' / directory, destination)
    shutil.copyfile(source / 'binding/binding.js', binding / 'binding.js')
    native = next((source / 'binding').glob('*.node'))
    root = results.parent / 'current-fixture'
    output = root / 'results'
    output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, SELECTORS=policy, FIXTURE_ROOT=str(root), SAMPLES='4', WARMUPS='2', SOURCE_HEAD=(source / 'head.txt').read_text().strip(), SOURCE_BASE=(source / 'base.txt').read_text().strip(), NAPI_RS_NATIVE_LIBRARY_PATH=str(native), NODE_OPTIONS='--max-old-space-size=8192')
    print(f'BEGIN {arm} block {block}', flush=True)
    peak = 0
    with (output / 'stdout.log').open('w') as stdout, (output / 'stderr.log').open('w') as stderr:
        process = subprocess.Popen(['node', '--expose-gc', str(here / 'fixture.mjs')], env=env, stdout=stdout, stderr=stderr)
        child = psutil.Process(process.pid)
        while process.poll() is None:
            try:
                info = child.memory_info()
                peak = max(peak, info.rss, getattr(info, 'peak_wset', 0))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            time.sleep(0.01)
        rc = process.wait()
    # Node's resourceUsage maxRSS is an OS high-water value on Unix. On
    # Windows use peak_wset (not Node's unsupported maxRSS field).
    if rc == 0:
        records = json.loads((output / 'builds.json').read_text())
        if sys.platform != 'win32':
            peak = max(peak, max(record['lifetimeMaxRssKiB'] for record in records) * 1024)
        assert len(records) == 5
        assert all(r['outputParity'] and r['preSplitTopologyReused'] for r in records[1:])
        assert [r['editedBytes'] - r['originalBytes'] for r in records[1:]] == [36, 0, 36, 0]
        assert all(r['tailRssSamples'] for r in records)
    (output / 'process.json').write_text(json.dumps({'block': block, 'arm': arm, 'source': build, 'policy': policy, 'exitCode': rc, 'peakRssBytes': peak, 'peakMethod': 'Windows PeakWorkingSetSize sampled every 10ms' if sys.platform == 'win32' else 'OS maxRSS plus 10ms RSS samples', 'nativeSha256': hashlib.sha256(native.read_bytes()).hexdigest()}, indent=2))
    destination = results / f'{arm}-{block}'
    shutil.move(str(output), str(destination))
    if rc:
        print((destination / 'stderr.log').read_text()[-10000:], file=sys.stderr)
        raise SystemExit(rc)
    shutil.rmtree(root)
    print(f'VALID {arm} block {block}', flush=True)
