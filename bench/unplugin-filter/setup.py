import base64
import hashlib
import json
import pathlib
import subprocess
import tarfile
import urllib.request

root = pathlib.Path.cwd()
u1 = json.loads((root / 'manifest.json').read_text())
u2 = json.loads((root / 'unplugin-3.4.0-u2-manifest.json').read_text())
assert u1['registry']['integrity'] == u2['registry']['integrity']
data = urllib.request.urlopen(u2['registry']['tarball']).read()
assert hashlib.sha1(data).hexdigest() == u2['registry']['shasum']
assert 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == u2['registry']['integrity']
(root / 'unplugin.tgz').write_bytes(data)
expected = {}
for arm in ('U0', 'U1', 'U2', 'RX'):
    dest = root / 'variants' / arm
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(root / 'unplugin.tgz') as archive:
        archive.extractall(dest, filter='data')
    (dest / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
    expected[arm] = {item['path']: item['sha256_before'] for item in u2['files']}
    for name, digest in expected[arm].items():
        assert hashlib.sha256((dest / 'package' / name).read_bytes()).hexdigest() == digest
    patch = {'U1': 'unplugin-3.4.0-dist.patch', 'U2': 'unplugin-3.4.0-dist-u2.patch'}.get(arm)
    if patch:
        manifest = u1 if arm == 'U1' else u2
        if arm == 'U2':
            assert hashlib.sha256((root / patch).read_bytes()).hexdigest() == manifest['patch_sha256']
        subprocess.run(['patch', '-p1', '-i', str(root / patch)], cwd=dest / 'package', check=True)
        expected[arm].update({item['path']: item['sha256_after'] for item in manifest['files']})
    for name, digest in expected[arm].items():
        assert hashlib.sha256((dest / 'package' / name).read_bytes()).hexdigest() == digest
    changes = []
    for file in (root / 'variants/U0/package').rglob('*'):
        if file.is_file():
            relative = file.relative_to(root / 'variants/U0/package')
            if file.read_bytes() != (dest / 'package' / relative).read_bytes():
                changes.append(str(relative))
    wanted = u1['files'] if arm == 'U1' else u2['files'] if arm == 'U2' else []
    assert sorted(changes) == sorted(item['path'] for item in wanted)
ledger = []
for file in sorted((root / 'node_modules').rglob('*')):
    if file.is_file():
        ledger.append([str(file.relative_to(root)), hashlib.sha256(file.read_bytes()).hexdigest()])
(root / 'results').mkdir(exist_ok=True)
(root / 'results/dependency-hashes.json').write_text(json.dumps(ledger))
(root / 'results/arm-hashes.json').write_text(json.dumps(expected, indent=2))
print('Registry integrity, all arm hashes, package differences and shared dependencies verified')

# Compatibility check only; 3.3.0 is not a measurement arm.
compat = json.loads((root / 'unplugin-3.3.0-u2-manifest.json').read_text())
data = urllib.request.urlopen(compat['registry']['tarball']).read()
assert hashlib.sha1(data).hexdigest() == compat['registry']['shasum']
assert 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == compat['registry']['integrity']
(root / 'unplugin-3.3.0.tgz').write_bytes(data)
dest = root / 'variants/U2-3.3.0'
dest.mkdir(parents=True, exist_ok=True)
with tarfile.open(root / 'unplugin-3.3.0.tgz') as archive:
    archive.extractall(dest, filter='data')
(dest / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
for item in compat['files']:
    assert hashlib.sha256((dest / 'package' / item['path']).read_bytes()).hexdigest() == item['sha256_before']
patch = root / 'unplugin-3.3.0-dist-u2.patch'
assert hashlib.sha256(patch.read_bytes()).hexdigest() == compat['patch_sha256']
subprocess.run(['patch', '-p1', '-i', str(patch)], cwd=dest / 'package', check=True)
for item in compat['files']:
    assert hashlib.sha256((dest / 'package' / item['path']).read_bytes()).hexdigest() == item['sha256_after']
print('3.3.0 compatibility patch integrity and before/after hashes verified')
