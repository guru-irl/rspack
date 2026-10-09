import base64
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request

root = pathlib.Path.cwd()
manifest = json.loads((root / 'manifest.json').read_text())
data = urllib.request.urlopen(manifest['registry']['tarball']).read()
assert hashlib.sha1(data).hexdigest() == manifest['registry']['shasum']
assert 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == manifest['registry']['integrity']
(root / 'unplugin.tgz').write_bytes(data)
for arm in ('stock', 'patched'):
    dest = root / 'variants' / arm
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(root / 'unplugin.tgz') as archive:
        archive.extractall(dest, filter='data')
    # Both variants resolve the same physical dependency installation.
    (dest / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
    for f in manifest['files']:
        assert hashlib.sha256((dest / 'package' / f['path']).read_bytes()).hexdigest() == f['sha256_before']
subprocess.run(['patch', '-p1', '-i', str(root / 'unplugin-3.4.0-dist.patch')], cwd=root / 'variants/patched/package', check=True)
for arm in ('stock', 'patched'):
    for f in manifest['files']:
        assert hashlib.sha256((root / 'variants' / arm / 'package' / f['path']).read_bytes()).hexdigest() == f['sha256_' + ('after' if arm == 'patched' else 'before')]
diffs = []
for f in (root / 'variants/stock/package').rglob('*'):
    if f.is_file():
        relative = f.relative_to(root / 'variants/stock/package')
        if f.read_bytes() != (root / 'variants/patched/package' / relative).read_bytes():
            diffs.append(str(relative))
assert sorted(diffs) == sorted(f['path'] for f in manifest['files'])
ledger = []
for f in sorted((root / 'node_modules').rglob('*')):
    if f.is_file():
        ledger.append([str(f.relative_to(root)), hashlib.sha256(f.read_bytes()).hexdigest()])
(root / 'results').mkdir(exist_ok=True)
(root / 'results/dependency-hashes.json').write_text(json.dumps(ledger))
print('Registry integrity, stock hashes, patched hashes and two-file-only difference verified')
