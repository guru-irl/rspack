import base64
import hashlib
import json
import pathlib
import subprocess
import tarfile
import urllib.request

root = pathlib.Path.cwd()
results = root / 'results'
results.mkdir(exist_ok=True)
expected = {}
for version, arms in [('3.4.0', ['U0', 'U0prime', 'U2r2', 'RX']), ('3.3.0', ['U2-3.3.0'])]:
    manifest = json.loads((root / f'unplugin-{version}-u2-manifest.json').read_text())
    patch = root / f'unplugin-{version}-dist-u2.patch'
    assert hashlib.sha256(patch.read_bytes()).hexdigest() == manifest['patch_sha256']
    data = urllib.request.urlopen(manifest['registry']['tarball']).read()
    assert hashlib.sha1(data).hexdigest() == manifest['registry']['shasum']
    assert 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == manifest['registry']['integrity']
    archive_path = root / f'unplugin-{version}.tgz'
    archive_path.write_bytes(data)
    for arm in arms:
        dest = root / 'variants' / arm
        dest.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive_path) as archive:
            archive.extractall(dest, filter='data')
        (dest / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
        package = dest / 'package'
        before = {p.relative_to(package).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in package.rglob('*') if p.is_file()}
        for item in manifest['files']:
            assert before[item['path']] == item['sha256_before']
        expected[arm] = dict(before)
        if arm.startswith('U2'):
            subprocess.run(['patch', '-p1', '-i', str(patch)], cwd=package, check=True)
            expected[arm].update({item['path']: item['sha256_after'] for item in manifest['files']})
        after = {p.relative_to(package).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in package.rglob('*') if p.is_file()}
        assert after == expected[arm]
        changed = sorted(name for name in before if before[name] != after[name])
        assert changed == (sorted(item['path'] for item in manifest['files']) if arm.startswith('U2') else [])
ledger = [[str(file.relative_to(root)), hashlib.sha256(file.read_bytes()).hexdigest()] for file in sorted((root / 'node_modules').rglob('*')) if file.is_file()]
(results / 'dependency-hashes.json').write_text(json.dumps(ledger))
(results / 'arm-hashes.json').write_text(json.dumps(expected, indent=2))
print('Registry integrity, full package hashes, exact package differences and shared dependencies verified')
