import hashlib
import io
import json
import pathlib
import re
import subprocess
import statistics
import zipfile

repo = 'guru-irl/rspack'
runs = [38944519067, 38944711948, 38944867155, 38945918425, 38946089938, 38947282645]
base = '96dcd72db4d25a89c37d22d514285ab82fc46a3d'
allowed_files = {'.github/workflows/module-id-study.yml', 'bench/module-id-study/benchmark.cjs', 'bench/module-id-study/summarize.py', 'bench/module-id-study/artifact-audit.py'}
allowed_hosts = {'api.github.com', 'github.com', 'registry.npmjs.org', 'npmjs.org', 'www.npmjs.com', 'npmjs.com', 'rspack.dev', 'react.dev', 'nodejs.org', 'docs.github.com', 'help.github.com', 'opensource.org', 'www.opensource.org', 'opencollective.com', 'git.io', 'support.github.com', 'npm.im', 'docs.npmjs.com', 'developer.github.com', 'aka.ms', 'securitylab.github.com', 'github.blog'}
manifest, findings, measurement_rows = [], [], []

def gh(endpoint):
    return subprocess.check_output(['gh', 'api', endpoint])

def scan(label, data):
    text = data.decode('utf-8', errors='replace')
    manifest.append({'name': label, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    paths = set(re.findall(r'/(?:Users|home|workspaces)/[^\s\"\'<>\\)\]}]*', text))
    unexpected_paths = [p for p in paths if not p.startswith('/home/runner/')]
    hosts = set(re.findall(r'https?://([a-zA-Z0-9_.-]+)', text))
    unexpected_hosts = [h for h in hosts if h not in allowed_hosts and not h.endswith(('.github.com', '.githubusercontent.com', '.blob.core.windows.net', '.actions.githubusercontent.com'))]
    if unexpected_paths or unexpected_hosts:
        # Do not copy any potentially private value into another public log.
        findings.append({'file': label, 'unexpectedPathCount': len(unexpected_paths), 'unexpectedHostCount': len(unexpected_hosts)})
    return paths, hosts

changed = subprocess.check_output(['git', 'diff', '--name-only', base, 'HEAD']).decode().splitlines()
if set(changed) - allowed_files:
    raise SystemExit('Unexpected tracked files outside the benchmark allowlist')
print('Tracked changes from public upstream main:', json.dumps(changed))
commits = subprocess.check_output(['git', 'rev-list', '--reverse', base + '..HEAD']).decode().splitlines()
for sha in commits:
    message = subprocess.check_output(['git', 'show', '-s', '--format=%B', sha])
    scan('commit-message:' + sha, message)
    print('Commit:', sha, message.decode().strip())
    for filename in subprocess.check_output(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', sha]).decode().splitlines():
        if filename not in allowed_files:
            raise SystemExit('Unexpected historical changed path')
        scan('commit-file:' + sha + ':' + filename, subprocess.check_output(['git', 'show', sha + ':' + filename]))

for run in runs:
    metadata = json.loads(gh(f'repos/{repo}/actions/runs/{run}'))
    print('Run:', run, metadata['status'], metadata['conclusion'])
    if metadata['status'] != 'completed':
        raise SystemExit('Refusing to audit a still-running producer')
    archive = gh(f'repos/{repo}/actions/runs/{run}/logs')
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        for name in z.namelist():
            if not name.endswith('/'):
                scan(f'run:{run}:log:{name}', z.read(name))
    artifacts = json.loads(gh(f'repos/{repo}/actions/runs/{run}/artifacts'))['artifacts']
    print('Artifacts:', run, [(a['id'], a['name'], a['size_in_bytes']) for a in artifacts])
    for artifact in artifacts:
        archive = gh(f'repos/{repo}/actions/artifacts/{artifact["id"]}/zip')
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            for name in z.namelist():
                if not name.endswith('/'):
                    content = z.read(name)
                    scan(f'run:{run}:artifact:{artifact["id"]}:{name}', content)
                    if run == 38946089938 and name == 'plain/results.jsonl':
                        measurement_rows = [json.loads(line) for line in content.decode().splitlines()]

root = pathlib.Path(__file__).parent / 'data'
root.mkdir(parents=True, exist_ok=True)
(root / 'audit-manifest.json').write_text(json.dumps({'files': manifest, 'findings': findings}, indent=2))
print('Audited objects:', len(manifest))
print('Audited uncompressed bytes:', sum(f['bytes'] for f in manifest))
print('Unexpected home/workspace paths or URL hosts:', json.dumps(findings))
print('Provenance: checked-in benchmark files only, published npm packages, generated JSX components and leaves, and public GitHub runner diagnostics. No application source or application measurement input is read by this workflow.')
if findings:
    raise SystemExit('Audit requires manual review; potentially private values were not echoed')
print('AUDIT PASS: all tracked changes are benchmark-only, and all captured home paths/URL hosts belong to the public runner or public services.')
for arm in ['deterministic', 'named', 'hashed', 'compact-hashed']:
    block_medians = [statistics.median(r['elapsedMs'] for r in measurement_rows if r['arm'] == arm and r['trial'] == trial and r['scenario'].startswith('content-')) for trial in range(5)]
    print('CONTENT BLOCK MEDIANS:', arm, json.dumps(block_medians), 'median=', statistics.median(block_medians))
    for scenario in ['initial', 'add10', 'add1000', 'insert-first']:
        row = next(r for r in measurement_rows if r['arm'] == arm and r['trial'] == 0 and r['scenario'] == scenario)
        print('ACCEPTED ROW:', json.dumps({k:v for k,v in row.items() if k not in ['logging', 'warnings']}))
    row = next(r for r in measurement_rows if r['arm'] == arm and r['trial'] == 0 and r['scenario'] == 'content-3')
    for context, values in row.get('logging', {}).items():
        for entry in values.get('entries', []):
            if 'cache' in entry.get('message', ''):
                print('CONTENT CACHE LOG:', arm, context, entry['message'])
