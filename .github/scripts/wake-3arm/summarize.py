import hashlib
import json
from pathlib import Path

r = Path('bench-data/results')
load = lambda p: json.loads(p.read_text())
summary = {'runner': (r / 'runner-image.txt').read_text().splitlines(), 'arms': {}}
for arm in ['official', 'W0', 'W46', 'WB2']:
    result = load(r / f'{arm}.json')
    assert result['errors'] == result['warnings'] == 0
    assert result['loaderCalls'] == dict(noop=60701, ast=6000, rewrite=3000)
    identity = load(r / f'{arm}.identity.json')
    native = Path(f'bench-data/{arm}.node').resolve()
    assert identity['path'] == str(native) and identity['mapped'] == [str(native)]
    assert identity['sha256'] == hashlib.sha256(native.read_bytes()).hexdigest()
    data = dict(sha256=identity['sha256'], buildMs=result['buildMs'], loaderCalls=result['loaderCalls'], errors=0, warnings=0)
    if arm != 'official':
        evidence = Path(f'bench-data/build-evidence/wake-{arm}-evidence')
        data.update(source=(evidence / 'source.sha').read_text().strip(),
                    buildSeconds=int((evidence / 'build-seconds.txt').read_text()),
                    buildStart=(evidence / 'build-start-utc.txt').read_text().strip(),
                    buildEnd=(evidence / 'build-end-utc.txt').read_text().strip(),
                    glibc=(evidence / 'glibc.txt').read_text().splitlines(),
                    compiled=(evidence / 'recompiled-crates.txt').read_text().splitlines())
    summary['arms'][arm] = data
assert len({x['sha256'] for x in summary['arms'].values()}) == 4
summary['errors'] = {}
for arm in ['W46', 'WB2']:
    parity = load(r / f'error-{arm}/error-parity.json')
    assert parity['accepted'] and len(parity['cases']) == 6
    assert all(c['diagnosticsByteIdentical'] and c['filesByteIdentical'] for c in parity['cases'])
    attempts = load(r / f'error-{arm}/error-parity/attempts.json')
    assert len(attempts) == 12 and all(a['exit'] == 0 and a['signal'] is None for a in attempts)
    summary['errors'][arm] = [c['which'] for c in parity['cases']]
summary['fakeTimers'] = {}
for arm in ['official', 'WB2']:
    result = load(r / f'fake-{arm}.json')
    assert result['fakeTimers'] and result['errors'] == result['warnings'] == 0
    assert result['loaderCalls'] == dict(noop=60701, ast=6000, rewrite=3000)
    identity = load(r / f'fake-{arm}.identity.json')
    assert identity['sha256'] == summary['arms'][arm]['sha256']
    assert identity['mapped'] == [identity['path']]
    summary['fakeTimers'][arm] = dict(buildMs=result['buildMs'], loaderCalls=result['loaderCalls'], errors=0, warnings=0)
bundle = r / 'official-output/bundle.cjs'
summary['output'] = dict(bytes=bundle.stat().st_size, sha256=hashlib.sha256(bundle.read_bytes()).hexdigest())
print(json.dumps(summary, indent=2))
