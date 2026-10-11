import subprocess,os,time,json,re,hashlib,statistics
from pathlib import Path
ROOT=Path(os.environ['IDS_RESULT_ROOT'])
PAIRS=int(os.environ.get('IDS_PAIRS','3'))
for block in range(1,PAIRS+1):
 order=['head','candidate'] if block%2 else ['candidate','head']
 for arm in order:
  env=os.environ.copy()
  for k in list(env):
   if k.startswith('RSPACK_') or k in ['NODE_OPTIONS','NAPI_RS_NATIVE_LIBRARY_PATH','IDS_CORE']:
    del env[k]
  env.update(RAYON_NUM_THREADS='8',TOKIO_WORKER_THREADS='8',IDS_CORE=os.environ['IDS_CORE'])
  env['NAPI_RS_NATIVE_LIBRARY_PATH']=os.environ['IDS_HEAD_BINDING' if arm=='head' else 'IDS_CANDIDATE_BINDING']
  samples=[]
  with (ROOT/f'logs/watch-{block}-{arm}.log').open('w') as log:
   p=subprocess.Popen(['node','--max-old-space-size=8192',str(Path(__file__).with_name('watch-run.cjs')),arm,str(block)],env=env,stdout=log,stderr=subprocess.STDOUT)
   while p.poll() is None:
    try:
     text=Path(f'/proc/{p.pid}/status').read_text()
     match=re.search(r'^VmRSS:\s+(\d+)',text,re.M)
     if match:samples.append({'time':time.time(),'rssKb':int(match[1])})
    except FileNotFoundError:pass
    time.sleep(.01)
   assert p.returncode==0,(block,arm,p.returncode)
  (ROOT/f'rss-{block}-{arm}.json').write_text(json.dumps(samples))
 a=json.loads((ROOT/f'run-{block}-head.json').read_text());b=json.loads((ROOT/f'run-{block}-candidate.json').read_text())
 assert len(a['steps'])==len(b['steps'])==7
 for x,y in zip(a['steps'],b['steps']):
  assert x['assets']==y['assets'],('ASSET MANIFEST BLOCKER',block,x['step'])
  for name in x['assets']:
   pa=ROOT/'assets'/f'block{block}'/'head'/f"step{x['step']}"/name
   pb=ROOT/'assets'/f'block{block}'/'candidate'/f"step{y['step']}"/name
   assert pa.read_bytes()==pb.read_bytes(),('ASSET BYTE BLOCKER',block,x['step'],name)
 print(f'BLOCK {block} ALL 7 STEPS BYTE-IDENTICAL',flush=True)
(ROOT/'PARITY_SUCCESS').touch()
