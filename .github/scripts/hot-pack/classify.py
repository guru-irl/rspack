import hashlib
import json
import re
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
    files = set()
    for report in reports:
        text = report.read_text()
        assert 'TEST_RUN_START' in text and 'TEST_RUN_END' in text, f'Incomplete test run: {arm}/{report.name}'
        for line in text.splitlines():
            fields = line.split(' | ')
            if len(fields) >= 4 and fields[1] in ('TEST_END', 'SUITE_END'):
                assert fields[3] in ('pass', 'fail', 'skip', 'todo'), f'Unknown reporter status: {fields[3]}'
                key = report.name + ' | ' + fields[0] + ' | ' + fields[1]
                statuses[key] = fields[3]
            elif len(fields) >= 4 and fields[1] == 'TEST_ERROR':
                errors[fields[0]] = ' | '.join(fields[3:])
            elif report == primary and len(fields) >= 2 and fields[1] == 'FILE_START':
                files.add(fields[0])
    primary_tests = {key: value for key, value in statuses.items() if key.startswith(primary.name + ' | ') and key.endswith(' | TEST_END')}
    assert sum(value == 'pass' for value in primary_tests.values()) > 1000, f'Insufficient passing test evidence: {arm}'
    log = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', (evidence / 'test-ci.log').read_text())
    assert not re.search(r'error TS\d+', log), f'Unclassified TypeScript diagnostic: {arm}'
    test_lines = []
    file_lines = []
    for line in log.splitlines():
        if 'tests/rspack-test test:' not in line:
            continue
        body = line.split('tests/rspack-test test:', 1)[1].strip()
        if re.match(r'Tests\s', body):
            test_lines.append(body)
        elif body.startswith('Test Files '):
            file_lines.append(body)
    assert test_lines and file_lines, f'Missing terminal suite summary: {arm}'
    terminal_tests = {state: int(count) for count, state in re.findall(r'(\d+)\s+(passed|failed|skipped|todo)', test_lines[-1])}
    terminal_files = {state: int(count) for count, state in re.findall(r'(\d+)\s+(passed|failed|skipped)', file_lines[-1])}
    primary_failed = [key for key, value in primary_tests.items() if value == 'fail']
    assert len(primary_failed) == terminal_tests.get('failed', 0), f'Failed-case evidence is incomplete or ambiguous: {arm}'
    for line in log.splitlines():
        if 'tests/rspack-test test:' not in line:
            continue
        body = line.split('tests/rspack-test test:', 1)[1].strip()
        match = re.fullmatch(r'FAIL\s+(.+\.test\.(?:m?js|[cm]?ts))\s*', body)
        if match:
            candidates = [file for file in files if Path(file).name == Path(match[1]).name]
            assert len(candidates) == 1, f'Ambiguous failed-file label: {body}'
            statuses[primary.name + ' | ' + candidates[0] + ' | FILE_FAIL'] = 'fail'
    failed_files = {key.split(' | ', 2)[1].split(' > ', 1)[0] for key, value in statuses.items() if key.startswith(primary.name + ' | ') and value == 'fail'}
    assert len(failed_files) == terminal_files.get('failed', 0), f'Failed-file evidence is incomplete: {arm}'
    assert len(files) == sum(terminal_files.values()), f'File execution evidence is incomplete: {arm}'
    failures = sorted(key for key, value in statuses.items() if value == 'fail')
    rc = int((evidence / 'test-ci.exit').read_text())
    assert rc == 0 or failures, f'Nonzero CI exit without classified test failures: {arm}'
    summary[arm] = {
        'source': (evidence / 'source.sha').read_text().strip(),
        'ciExit': rc,
        'nativeSha256': digest,
        'identityContexts': len({(row['pid'], row['threadId']) for row in identities}),
        'primaryTestCounts': terminal_tests,
        'primaryFileCounts': terminal_files,
        'failedTestIds': sorted(key.split(' | ', 2)[1] for key in primary_failed),
        'primaryUniqueContextCounts': {state: sum(value == state for value in primary_tests.values()) for state in sorted(set(primary_tests.values()))},
        'failures': failures,
        'errors': errors,
    }
control = set(summary['CONTROL']['failures'])
treatment = set(summary['TREATMENT']['failures'])
summary['sharedFailures'] = sorted(control & treatment)
summary['controlOnlyFailures'] = sorted(control - treatment)
summary['treatmentOnlyFailures'] = sorted(treatment - control)
summary['failedTestIdSetsIdentical'] = summary['CONTROL']['failedTestIds'] == summary['TREATMENT']['failedTestIds']
summary['verdict'] = 'BLOCKED' if treatment - control else 'NO TREATMENT-ONLY FAILURES'
(root / 'results' / 'test-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({arm: {key: value for key, value in summary[arm].items() if key not in ('errors', 'failures')} for arm in ('CONTROL', 'TREATMENT')}, indent=2))
print('Shared failed test, suite or file records:', len(summary['sharedFailures']))
print('Treatment-only failures:', json.dumps(summary['treatmentOnlyFailures'], indent=2))
assert not summary['treatmentOnlyFailures'], 'ESCALATION: treatment-only test failure blocks delivery'
assert summary['failedTestIdSetsIdentical'], 'ESCALATION: failing test ID sets differ between arms'
