import os,subprocess,sys
from pathlib import Path
h=Path(__file__).resolve().parent
for script,args in [('build.py',[]),('series.py',['--prepare'])]:subprocess.run([sys.executable,str(h/script),sys.argv[1],*args],check=True)
subprocess.run([sys.executable,str(h/'series.py'),sys.argv[1]],env=dict(os.environ,CLOSE_DIRECT='1'),check=True)
subprocess.run([sys.executable,str(h/'series.py'),sys.argv[1]],check=True)
