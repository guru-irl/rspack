"""Public synthetic reproduction. Run only on a GitHub hosted runner."""
import argparse
import collections
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import time
import psutil

p = argparse.ArgumentParser()
p.add_argument('--package', required=True)
p.add_argument('--fixture', required=True)
p.add_argument('--results', required=True)
p.add_argument('--launches', type=int, default=2)
p.add_argument('--arm', default='baseline')
a = p.parse_args()
results = Path(a.results).resolve()
results.mkdir(parents=True, exist_ok=True)
script = Path(__file__).with_name('build.cjs').resolve()
metadata = {'platform': platform.platform(), 'cpu_count': os.cpu_count(), 'memory': psutil.virtual_memory()._asdict(), 'arm': a.arm, 'sample_period_ms': 100, 'environment': {k: v for k, v in os.environ.items() if k.startswith(('MIMALLOC_', 'RSPACK_', 'TOKIO_', 'RAYON_', 'NODE_OPTIONS'))}}
(results / 'host.json').write_text(json.dumps(metadata, indent=2))
summaries = []

def events_at(file):
    if not file.exists():
        return []
    return [json.loads(x) for x in file.read_text().splitlines() if x]

for launch in range(1, a.launches + 1):
    dest = results / f'launch-{launch:02d}'
    dest.mkdir()
    events = dest / 'events.jsonl'
    env = {k: v for k, v in os.environ.items() if not k.startswith('MIMALLOC_')}
    if a.arm == 'purge-zero':
        env['MIMALLOC_PURGE_DELAY'] = '0'
    elif a.arm == 'no-reclaim-on-free':
        env['MIMALLOC_PAGE_RECLAIM_ON_FREE'] = '-1'
    elif a.arm == 'stats':
        env.update(MIMALLOC_SHOW_STATS='1', MIMALLOC_VERBOSE='1')
    elif a.arm != 'baseline':
        raise ValueError(a.arm)
    env['NODE_OPTIONS'] = '--max-old-space-size=4096'
    with (dest / 'stdout.log').open('w') as out, (dest / 'stderr.log').open('w') as err, (dest / 'timeline.jsonl').open('w') as timeline:
        start = time.time_ns()
        started = time.monotonic()
        child = subprocess.Popen(['node', str(script), str(Path(a.package).resolve()), str(Path(a.fixture).resolve()), str(events), str(dest / 'output')], stdout=out, stderr=err, env=env)
        proc = psutil.Process(child.pid)
        samples = []
        next_sample = time.monotonic()
        timed_out = False
        while child.poll() is None:
            now = time.time_ns()
            try:
                info = proc.memory_info()
                sample = {'wall_ns': now, 'elapsed_s': (now - start) / 1e9, 'rss': info.rss, 'vms': info.vms, 'num_threads': proc.num_threads()}
                if platform.system() == 'Linux':
                    status = Path(f'/proc/{child.pid}/status').read_text()
                    for line in status.splitlines():
                        if line.startswith(('RssAnon:', 'RssFile:', 'RssShmem:', 'VmSwap:')):
                            key, value, *_ = line.split()
                            sample[key[:-1]] = int(value) * 1024
                    threads = {}
                    for task in Path(f'/proc/{child.pid}/task').iterdir():
                        try:
                            threads[task.name] = (task / 'comm').read_text().strip()
                        except FileNotFoundError:
                            pass
                    sample['threads'] = threads
                else:
                    sample['threads'] = {str(t.id): None for t in proc.threads()}
                timeline.write(json.dumps(sample, separators=(',', ':')) + '\n')
                samples.append(sample)
            except (psutil.NoSuchProcess, ProcessLookupError, FileNotFoundError):
                pass
            if time.monotonic() - started > 600:
                timed_out = True
                child.kill()
                break
            next_sample += 0.1
            time.sleep(max(0, next_sample - time.monotonic()))
        rc = child.wait()
    ev = events_at(events)
    done = next((int(e['wall_ns']) for e in ev if e['kind'] == 'build_done'), None)
    server = next((int(e['wall_ns']) for e in ev if e['kind'] == 'compiler_done' and e['compiler'] == 'server'), None)
    metric = 'RssAnon' if platform.system() == 'Linux' else 'rss'
    valid = rc == 0 and done is not None and any(e['kind'] == 'idle_mark' and e['seconds'] == 60 for e in ev)
    summary = {'launch': launch, 'valid': valid, 'exit_code': rc, 'timed_out': timed_out, 'metric': metric, 'samples': len(samples), 'build_s': (done-start)/1e9 if done else None, 'server_done_s': (server-start)/1e9 if server else None, 'peak_rss_mib': max((s['rss'] for s in samples), default=0)/2**20}
    if valid:
        after = [s for s in samples if s['wall_ns'] >= done]
        def med(lo, hi):
            return statistics.median([s[metric] for s in after if lo <= (s['wall_ns']-done)/1e9 <= hi]) / 2**20
        summary.update(peak_metric_mib=max(s[metric] for s in samples)/2**20, tail_0_1_mib=med(0,1), tail_3_5_mib=med(3,5), tail_12_15_mib=med(12,15), steady_55_60_mib=med(55,60))
        # Compare windows separated by 0.5 seconds; no causal label implied.
        drops = []
        for i, s in enumerate(after):
            if i < 5:
                continue
            prev = after[i-5]
            amount = (prev[metric] - s[metric])/2**20
            gone = set(prev['threads']) - set(s['threads'])
            names = collections.Counter(prev['threads'][tid] or 'unknown' for tid in gone)
            drops.append({'after_done_s': (s['wall_ns']-done)/1e9, 'amount_mib': amount, 'threads_gone': dict(names), 'thread_count_before': prev['num_threads'], 'thread_count_after': s['num_threads']})
        summary['largest_idle_drop'] = max(drops, key=lambda x:x['amount_mib'], default=None)
        summary['largest_late_drop'] = max((d for d in drops if 3 <= d['after_done_s'] <= 20), key=lambda x:x['amount_mib'], default=None)
        summary['delayed_256mib'] = summary['tail_3_5_mib'] - summary['tail_12_15_mib'] >= 256
        summary['thread_transitions'] = []
        previous = samples[0]
        for s in samples[1:]:
            gone = set(previous['threads']) - set(s['threads'])
            if gone:
                summary['thread_transitions'].append({'after_done_s': (s['wall_ns']-done)/1e9, 'gone': {tid:previous['threads'][tid] for tid in gone}, 'metric_mib': s[metric]/2**20})
            previous = s
    (dest / 'summary.json').write_text(json.dumps(summary, indent=2))
    summaries.append(summary)
    print(json.dumps(summary, separators=(',', ':')), flush=True)
    # Remove emitted synthetic files, not evidence; no overlapping launches.
    import shutil
    shutil.rmtree(dest / 'output', ignore_errors=True)
(results / 'summaries.json').write_text(json.dumps(summaries, indent=2))
if not all(s['valid'] for s in summaries):
    raise SystemExit('One or more failed launches: excluded from samples')
