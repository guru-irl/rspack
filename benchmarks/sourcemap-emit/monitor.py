import json, os, pathlib, subprocess, sys, threading, time
out = pathlib.Path(os.environ['STUDY_RESULTS']); out.mkdir(parents=True, exist_ok=True)
name = os.environ['STUDY_LABEL'] + '-' + os.environ['STUDY_ARM']
with (out / (name + '.log')).open('w') as log:
    p = subprocess.Popen(['node', '--expose-gc', '--max-old-space-size=8192', 'benchmarks/sourcemap-emit/watch.cjs'], stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    state = {'active': False, 'peak': 0, 'processPeak': 0, 'samples': []}
    def reader():
        for line in p.stdout:
            log.write(line); log.flush()
            if line.startswith('STUDY_BEGIN'):
                state['active'] = True; state['peak'] = 0
            if line.startswith('STUDY_END '):
                state['active'] = False
                sample = json.loads(line[len('STUDY_END '):]); sample['peakRss'] = max(state['peak'], sample['rss']); state['samples'].append(sample)
    t = threading.Thread(target=reader); t.start()
    while p.poll() is None:
        try:
            stat = pathlib.Path(f'/proc/{p.pid}/status').read_text()
            rss = int(next(line.split()[1] for line in stat.splitlines() if line.startswith('VmRSS:'))) * 1024
            state['processPeak'] = max(state['processPeak'], rss)
            if state['active']: state['peak'] = max(state['peak'], rss)
        except (FileNotFoundError, StopIteration, ProcessLookupError): pass
        time.sleep(.01)
    t.join()
    (out / (name + '-rss.json')).write_text(json.dumps({'samples': state['samples'], 'wholeProcessPeak': state['processPeak'], 'exitCode': p.returncode}, indent=2))
    if p.returncode: sys.exit(p.returncode)
