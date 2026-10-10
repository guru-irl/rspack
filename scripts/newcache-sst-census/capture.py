import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

root = Path.cwd()
results = root / 'results'
marker = results / 'first-store-marker'
env = os.environ.copy()
env['LD_PRELOAD'] = str(root / '.spider/scratch/capture.so')
env['SST_CAPTURE_MARKER'] = str(marker)
with (results / 'build.log').open('w') as log:
    process = subprocess.Popen(['node', 'scripts/newcache-sst-census/run.mjs'], env=env, stdout=log, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 600
    while not marker.exists():
        if process.poll() is not None:
            raise RuntimeError(f'Build exited before capture: {process.returncode}')
        if time.monotonic() > deadline:
            process.kill()
            raise RuntimeError('Capture deadline exceeded')
        time.sleep(0.01)
    lines = marker.read_text().splitlines()
    pid = int(lines[0])
    current = Path(lines[1])
    assert pid == process.pid
    while ') T ' not in Path(f'/proc/{pid}/stat').read_text():
        if time.monotonic() > deadline:
            process.kill()
            raise RuntimeError('SIGSTOP did not complete')
        time.sleep(0.001)
    database = current.parent
    sequence = int.from_bytes(current.read_bytes(), 'big')
    assert sequence > 0
    pre = results / 'pre-compaction'
    shutil.copytree(database, pre)
    os.kill(pid, signal.SIGCONT)
    rc = process.wait(timeout=300)
    if rc:
        raise RuntimeError(f'Build/idle/close failed: {rc}; see build.log')
post = results / 'post-compaction'
shutil.copytree(database, post)
pre_log = (pre / 'LOG').read_text() if (pre / 'LOG').exists() else ''
post_log = (post / 'LOG').read_text()
assert 'Compaction:' not in pre_log
assert 'Compaction:' in post_log, 'No actual compaction occurred'
post_sequence = int.from_bytes((post / 'CURRENT').read_bytes(), 'big')
assert post_sequence > sequence
(results / 'capture.json').write_text(json.dumps({
    'first_store_sequence': sequence, 'post_compaction_sequence': post_sequence,
    'database_relative_path': str(database.relative_to(root)),
    'capture': 'LD_PRELOAD intercepts successful rename of nonzero CURRENT, SIGSTOP all threads, copy then SIGCONT',
    'pre_log_compactions': pre_log.count('Compaction:'),
    'post_log_compactions': post_log.count('Compaction:'),
    'closed_successfully': True,
}, indent=2))
