import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

HERE=Path(__file__).resolve().parent
config=json.loads(Path(sys.argv[1]).read_text())
root=Path(os.environ['HARNESS_WORK']).resolve()
results=Path(os.environ['HARNESS_RESULTS']).resolve();results.mkdir(parents=True,exist_ok=True)
root.mkdir(parents=True,exist_ok=True)
repo=Path.cwd()
# Resolve from the source worktrees so their pinned Rust toolchain is recorded.
provenance=dict(harness_sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),patch_sha256=hashlib.sha256((HERE/'idle-completion.patch').read_bytes()).hexdigest(),generator_sha256=hashlib.sha256((HERE/'gen.mjs').read_bytes()).hexdigest(),platform=platform.platform(),arms={},tools={})
for tool,args in [('node',['--version']),('pnpm',['--version'])]:
 provenance['tools'][tool]=subprocess.check_output((['cmd','/c'] if sys.platform=='win32' and tool=='pnpm' else [])+[tool]+args,text=True).strip()
cores={}
for arm,sha in config['arms'].items():
 if len(sha)!=40 or any(c not in '0123456789abcdef' for c in sha):raise ValueError('Full source SHA required')
 source=root/('source-'+arm)
 subprocess.run(['git','fetch','origin',sha],check=True)
 subprocess.run(['git','worktree','add','--detach',str(source),sha],check=True)
 subprocess.run(['git','apply','--check',str(HERE/'idle-completion.patch')],cwd=source,check=True)
 subprocess.run(['git','apply',str(HERE/'idle-completion.patch')],cwd=source,check=True)
 tmp=root/('tmp-'+arm);tmp.mkdir(exist_ok=True)
 env=dict(os.environ,TMPDIR=str(tmp),TMP=str(tmp),TEMP=str(tmp),CARGO_INCREMENTAL='0',CARGO_TARGET_DIR=str(source/'target'))
 provenance['tools']['rustc_'+arm]=subprocess.check_output(['rustc','--version'],cwd=source,text=True).strip()
 subprocess.run(['rustup','component','add','rust-src'],cwd=source,env=env,check=True)
 subprocess.run(['cargo','codegen'],cwd=source,env=env,check=True)
 # Build on the measuring host. No runtime packaging or artifact transfer.
 for name,command in [('install',['pnpm','install','--frozen-lockfile']),('release',['pnpm','run','build:cli:release'])]:
  if sys.platform=='win32':command=['cmd','/c']+command
  with (results/f'build-{arm}-{name}.log').open('w') as log:
   subprocess.run(command,cwd=source,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
 subprocess.run(['node','--input-type=module','-e',f'import({json.dumps((source / "packages/rspack/dist/index.js").as_uri())}).then(m=>console.log(m.rspack.version))'],cwd=source,check=True)
 binaries=list((source/'crates/node_binding').glob('*.node'))
 if len(binaries)!=1:raise RuntimeError(f'Expected one binding, got {binaries}')
 b=binaries[0]
 provenance['arms'][arm]=dict(source_sha=sha,native_sha256=hashlib.sha256(b.read_bytes()).hexdigest(),native_bytes=b.stat().st_size)
 cores[arm]=str(source/'packages/rspack/dist/index.js')
 # Remove only this disposable worktree's build artifacts.
 targets=[source/'target']
 if env.get('CARGO_TARGET_DIR'): targets.append(Path(env['CARGO_TARGET_DIR']))
 for target in targets:
  if target.exists(): shutil.rmtree(target)
 (results/'provenance.json').write_text(json.dumps(provenance,indent=2))
(root/'cores.json').write_text(json.dumps(cores))
if sys.platform=='darwin':
 # Installed runtime version headers; all scratch stays under the configured work dir.
 import tarfile,urllib.request
 version=subprocess.check_output(['node','--version'],text=True).strip()
 archive=root/'node-headers.tar.gz'
 urllib.request.urlretrieve(f'https://nodejs.org/dist/{version}/node-{version}-headers.tar.gz',archive)
 with tarfile.open(archive) as tar:tar.extractall(root,filter='data')
 subprocess.run(['clang','-O2','-shared','-undefined','dynamic_lookup','-I'+str(root/f'node-{version}/include/node'),str(HERE/'memory.c'),'-o',str(HERE/'memory.node')],check=True)
