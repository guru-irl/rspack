import json
import re
import sys
from pathlib import Path

root = Path('bench-data/results')
arm = sys.argv[1]
text = (root / f'{arm}.events').read_text()
assert 'TEST_RUN_START' in text and 'TEST_RUN_END' in text, 'Incomplete events'
states = {}
for line in text.splitlines():
    fields = line.split(' | ')
    if len(fields) >= 4 and fields[1] in ('TEST_END', 'SUITE_END'):
        assert fields[3] in ('pass', 'fail', 'skip', 'todo'), fields
        states[(fields[0], fields[1])] = fields[3]
assert states, 'Missing tests'
failures = sorted([key[0].split('/tests/rspack-test/', 1)[-1], key[1]] for key, state in states.items() if state == 'fail')
tests = {key[0]: state for key, state in states.items() if key[1] == 'TEST_END'}
log = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', (root / f'{arm}.log').read_text())
assert not re.search(r'error TS\d+', log)
terminal = [line for line in log.splitlines() if re.match(r'^\s*Tests\s', line)]
assert terminal, 'Missing terminal totals'
totals = {state: int(count) for count, state in re.findall(r'(\d+)\s+(passed|failed|skipped|todo)', terminal[-1])}
assert sum(state == 'fail' for state in tests.values()) == totals.get('failed', 0)
assert sum(state == 'pass' for state in tests.values()) == totals.get('passed', 0)
rc = int((root / f'{arm}.exit').read_text())
if arm in ('watch-normal', 'watch-forced'):
    expected = json.loads(Path(__file__).with_name('watch-baseline.json').read_text())
    assert failures == expected, {'actual': failures, 'expected': expected}
    assert totals['failed'] == 6 and totals['passed'] >= 960, totals
    assert rc == 1
elif arm == 'case-on':
    assert rc == 0 and not failures and totals.get('passed', 0) == 6, totals
    for suffix, count in [('stable-absence', 4), ('stable-absence-side-effects', 2)]:
        selected = [state for name, state in tests.items() if f'/{suffix} > ' in name]
        assert len(selected) == count and all(state == 'pass' for state in selected), (suffix, selected)
elif arm == 'case-side-effects-red':
    failed_tests = [name for name, state in tests.items() if state == 'fail']
    assert rc == 1 and len(failed_tests) == 1, failed_tests
    assert 'stable-absence-side-effects' in failed_tests[0] and 'should compile step 1' in failed_tests[0], failed_tests
    assert 'zRan' in log and 'expected undefined to be true' in log, log
elif arm == 'case-off':
    failed_tests = [name for name, state in tests.items() if state == 'fail']
    assert rc == 1 and len(failed_tests) == 1, failed_tests
    assert 'stable-absence' in failed_tests[0] and 'should compile step 1' in failed_tests[0], failed_tests
    assert totals.get('passed', 0) == 5 and totals.get('failed', 0) == 1, totals
    side_effects = [state for name, state in tests.items() if '/stable-absence-side-effects > ' in name]
    assert len(side_effects) == 2 and all(state == 'pass' for state in side_effects), side_effects
    assert 'module topology change detected' in log
else:
    raise AssertionError(f'Unknown arm: {arm}')
summary = {'arm': arm, 'totals': totals, 'failures': failures}
(root / f'{arm}-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
