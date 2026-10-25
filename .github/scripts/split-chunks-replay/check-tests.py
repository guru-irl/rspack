import json
import re
from pathlib import Path

root = Path('bench-data/results')
summary = {}
for arm in ('normal', 'forced'):
    text = (root / f'watch-{arm}.events').read_text()
    assert 'TEST_RUN_START' in text and 'TEST_RUN_END' in text, f'Incomplete {arm} events'
    states = {}
    for line in text.splitlines():
        fields = line.split(' | ')
        if len(fields) >= 4 and fields[1] in ('TEST_END', 'SUITE_END'):
            assert fields[3] in ('pass', 'fail', 'skip', 'todo'), fields
            states[(fields[0], fields[1])] = fields[3]
    tests = {key[0]: state for key, state in states.items() if key[1] == 'TEST_END'}
    assert len(tests) > 200, f'Missing watch cases in {arm}'
    replay = {key: state for key, state in tests.items() if re.search(r'/split-chunks/replay(?:-disabled)?(?:/| >)', key)}
    assert len(replay) >= 16 and all(state == 'pass' for state in replay.values()), replay
    log = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', (root / f'watch-{arm}.log').read_text())
    assert not re.search(r'error TS\d+', log), f'TypeScript errors in {arm}'
    terminal = [line for line in log.splitlines() if re.match(r'^\s*Tests\s', line)]
    assert terminal, f'Missing {arm} terminal totals'
    totals = {state: int(count) for count, state in re.findall(r'(\d+)\s+(passed|failed|skipped|todo)', terminal[-1])}
    assert sum(state == 'fail' for state in tests.values()) == totals.get('failed', 0), totals
    assert sum(state == 'pass' for state in tests.values()) == totals.get('passed', 0), totals
    exit_code = int((root / f'watch-{arm}.exit').read_text())
    failures = sorted(' | '.join(key) for key, state in states.items() if state == 'fail')
    if exit_code:
        assert failures, f'Unclassified file or runner failure in {arm}'
    summary[arm] = {'exit': exit_code, 'totals': totals, 'failures': failures, 'replayTests': replay}
extra = sorted(set(summary['forced']['failures']) - set(summary['normal']['failures']))
summary['forcedOnlyFailures'] = extra
(root / 'test-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
assert not extra, f'Forced-only failures: {extra}'
config = (root / 'config-cases.events').read_text()
assert 'TEST_RUN_END' in config
assert not any(' | TEST_END | ' in line and ' | fail | ' in line for line in config.splitlines())
print(json.dumps({arm: row['totals'] for arm, row in summary.items() if isinstance(row, dict)}, indent=2))
print('Forced watch pass has no additional failing test or suite IDs.')
