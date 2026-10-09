"""Install exact public packages and record commit, package and native provenance."""
import hashlib,json,os,platform,subprocess
from pathlib import Path
root=Path(os.environ.get('BUILDINFO_BENCH_DIR','.bench/buildinfo-access')).resolve()
root.mkdir(parents=True,exist_ok=True)
canary='2.2.9-canary-a9cfd15e-20261009001219'
commit='a9cfd15e04efb596dac0c101b15477c402411e7c'
required=['f93a311052','53e259af9f']
for ancestor in required:subprocess.run(['git','merge-base','--is-ancestor',ancestor,commit],check=True)
assert commit[:8] in canary
provenance={'canaryCommit':commit,'includedCommits':required,'versions':{},'machine':platform.uname()._asdict(),'nodeVersion':subprocess.check_output(['node','--version'],text=True).strip()}
for version,scope,pin in [('release','@rspack','2.2.8'),('canary','@rspack-canary',canary)]:
    dest=root/version;dest.mkdir(exist_ok=True)
    deps={f'@rspack/{name}':f'npm:{scope}/{name}@{pin}' if version=='canary' else pin for name in ['core','binding','binding-linux-x64-gnu']}
    (dest/'package.json').write_text(json.dumps({'private':True,'dependencies':deps},indent=2)+'\n')
    metadata={}
    for name in ['core','binding','binding-linux-x64-gnu']:
        metadata[name]=json.loads(subprocess.check_output(['npm','view',f'{scope}/{name}@{pin}','name','version','dependencies','optionalDependencies','dist.tarball','dist.integrity','--json','--registry=https://registry.npmjs.org'],text=True))
        assert metadata[name]['version']==pin,metadata[name]
    subprocess.run(['npm','install','--registry=https://registry.npmjs.org','--omit=optional','--no-audit','--no-fund'],cwd=dest,check=True)
    for name in ['core','binding','binding-linux-x64-gnu']:
        manifest=json.loads((dest/'node_modules/@rspack'/name/'package.json').read_text())
        assert manifest['version']==pin and manifest['name']==f'{scope}/{name}',manifest
    native=dest/'node_modules/@rspack/binding-linux-x64-gnu/rspack.linux-x64-gnu.node'
    provenance['versions'][version]={'version':pin,'metadata':metadata,'nativeSha256':hashlib.sha256(native.read_bytes()).hexdigest(),'nativeBytes':native.stat().st_size}
(root/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
(root/'ambient.json').write_text(json.dumps({'loadavg':os.getloadavg(),'meminfo':Path('/proc/meminfo').read_text(),'cpuCount':os.cpu_count(),'disk':subprocess.check_output(['df','-h',str(root)],text=True)},indent=2)+'\n')
print('Pinned public package versions and canary ancestry verified')
