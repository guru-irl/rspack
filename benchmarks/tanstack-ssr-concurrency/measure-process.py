import subprocess,sys,time,json,os
from pathlib import Path
out=Path(os.environ['RESULT_DIR'])
samples=[]
with (out/'node-console.log').open('w') as log:
    process=subprocess.Popen(['node','run.mjs'],stdout=log,stderr=subprocess.STDOUT)
    while process.poll() is None:
        try:
            values={}
            for line in Path(f'/proc/{process.pid}/status').read_text().splitlines():
                if line.startswith(('VmRSS:','VmHWM:')):
                    key,value,*_=line.split();values[key[:-1]]=int(value)*1024
            samples.append({'wallMs':time.time_ns()/1000000,**values})
        except (FileNotFoundError,ProcessLookupError): pass
        time.sleep(.01)
    rc=process.wait()
(out/'rss.json').write_text(json.dumps(samples))
print((out/'node-console.log').read_text()[-5000:])
sys.exit(rc)
