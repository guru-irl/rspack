import json
import os
import pathlib
import platform
import subprocess

root = pathlib.Path('results')
root.mkdir(exist_ok=True)
cpu = next(line.split(':', 1)[1].strip() for line in pathlib.Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name'))
ram = next(float(line.split()[1]) / 1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))
host = {'cpu_model': cpu, 'cpus': os.cpu_count(), 'ram_mib': ram, 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'platform': platform.platform(), 'load': os.getloadavg(), 'commit': os.environ['GITHUB_SHA'], 'run_url': 'https://github.com/' + os.environ['GITHUB_REPOSITORY'] + '/actions/runs/' + os.environ['GITHUB_RUN_ID']}
(root / 'host.json').write_text(json.dumps(host, indent=2))
print(json.dumps(host))
