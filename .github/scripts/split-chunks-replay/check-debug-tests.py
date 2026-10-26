import json
import re
from pathlib import Path

root = Path('bench-data/results')
text = (root / 'watch-normal.events').read_text()
assert 'TEST_RUN_START' in text and 'TEST_RUN_END' in text, 'Incomplete watch events'
states = {}
for line in text.splitlines():
    fields = line.split(' | ')
    if len(fields) >= 4 and fields[1] in ('TEST_END', 'SUITE_END'):
        assert fields[3] in ('pass', 'fail', 'skip', 'todo'), fields
        states[(fields[0], fields[1])] = fields[3]
tests = {key[0]: state for key, state in states.items() if key[1] == 'TEST_END'}
failed = [key for key, state in tests.items() if state == 'fail']
assert len(failed) == 6, failed
failures = sorted([key[0].split('/tests/rspack-test/', 1)[-1], key[1]] for key, state in states.items() if state == 'fail')
expected = json.loads(Path(__file__).with_name('watch-baseline.json').read_text())
assert failures == expected, {'actual': failures, 'expected': expected}
log = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', (root / 'watch-normal.log').read_text())
assert not re.search(r'error TS\d+', log)
terminal = [line for line in log.splitlines() if re.match(r'^\s*Tests\s', line)]
assert terminal, 'Missing terminal totals'
totals = {state: int(count) for count, state in re.findall(r'(\d+)\s+(passed|failed|skipped|todo)', terminal[-1])}
assert sum(state == 'fail' for state in tests.values()) == totals.get('failed', 0) == 6
assert sum(state == 'pass' for state in tests.values()) == totals.get('passed', 0) == 960
assert int((root / 'watch-normal.exit').read_text()) == 1
summary = {'totals': totals, 'failures': failures, 'newFailures': []}
(root / 'test-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
