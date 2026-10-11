import json
import os
from pathlib import Path
import subprocess
import sys
h=Path(__file__).resolve().parent
config=Path(sys.argv[1]).resolve()
c=json.loads(config.read_text())
if not c['enabled']:print('Harness disabled in config');sys.exit(0)
subprocess.run([sys.executable,str(h/'build.py'),str(config)],check=True)
cores=json.loads((Path(os.environ['HARNESS_WORK'])/'cores.json').read_text())
env=dict(os.environ,**{'CORE_'+arm:path for arm,path in cores.items()})
subprocess.run([sys.executable,str(h/'series.py'),str(config),'--prepare'],env=env,check=True)
subprocess.run([sys.executable,str(h/'series.py'),str(config)],env=env,check=True)
