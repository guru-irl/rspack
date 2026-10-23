import hashlib
import json
from pathlib import Path

root = Path('bench-data')
summary = {}
for arm in ('CONTROL', 'TREATMENT'):
    evidence = root / 'evidence' / f'hot-{arm}-evidence'
    native = root / 'packages' / f'hot-{arm}-packages' / 'rspack.linux-x64-gnu.node'
    digest = hashlib.sha256(native.read_bytes()).hexdigest()
    identities = [json.loads(line) for line in (evidence / 'test-native-identities.jsonl').read_text().splitlines()]
    assert identities and all(row['sha256'] == digest and row['path'] == row['mapped'][0] and len(row['mapped']) == 1 for row in identities), arm
    statuses = {}
    errors = {}
    reports = sorted(evidence.glob('*-report.txt'))
    assert reports, arm
    primary = evidence / 'rspack-test-event-report.txt'
    text = primary.read_text()
    assert 'TEST_RUN_START' in text and 'TEST_RUN_END' in text, f'Incomplete test suite: {arm}'
    for report in reports:
        for line in report.read_text().splitlines():
            fields = line.split(' | ')
            if len(fields) >= 4 and fields[1] in ('TEST_END', 'SUITE_END'):
                key = report.name + ' | ' + fields[0] + ' | ' + fields[1]
                statuses[key] = fields[3]
            elif len(fields) >= 4 and fields[1] == 'TEST_ERROR':
                errors[fields[0]] = ' | '.join(fields[3:])
    primary_tests = {key: value for key, value in statuses.items() if key.startswith(primary.name + ' | ') and key.endswith(' | TEST_END')}
    assert len(primary_tests) > 1000, f'Insufficient test evidence: {arm}'
    failures = sorted(key for key, value in statuses.items() if value == 'failed')
    rc = int((evidence / 'test-ci.exit').read_text())
    assert rc == 0 or failures, f'Nonzero CI exit without classified test failures: {arm}'
    summary[arm] = {
        'source': (evidence / 'source.sha').read_text().strip(),
        'ciExit': rc,
        'nativeSha256': digest,
        'identityContexts': len({(row['pid'], row['threadId']) for row in identities}),
        'primaryTestCounts': {state: sum(value == state for value in primary_tests.values()) for state in sorted(set(primary_tests.values()))},
        'failures': failures,
        'errors': errors,
    }
control = set(summary['CONTROL']['failures'])
treatment = set(summary['TREATMENT']['failures'])
summary['sharedFailures'] = sorted(control & treatment)
summary['controlOnlyFailures'] = sorted(control - treatment)
summary['treatmentOnlyFailures'] = sorted(treatment - control)
summary['verdict'] = 'BLOCKED' if treatment - control else 'NO TREATMENT-ONLY FAILURES'
(root / 'results' / 'test-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({arm: {key: value for key, value in summary[arm].items() if key not in ('errors', 'failures')} for arm in ('CONTROL', 'TREATMENT')}, indent=2))
print('Shared failed test or suite events:', len(summary['sharedFailures']))
print('Treatment-only failures:', json.dumps(summary['treatmentOnlyFailures'], indent=2))
assert not summary['treatmentOnlyFailures'], 'ESCALATION: treatment-only test failure blocks delivery'
