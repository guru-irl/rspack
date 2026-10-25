import json
import re
from pathlib import Path

root = Path('bench-data/results')
summary = {}
for repeat in (1, 2):
    for arm in ('normal', 'forced'):
        for suite in ('watch', 'compiler', 'multi'):
            label = f'{suite}-{arm}-{repeat}'
            text = (root / f'{label}.events').read_text()
            assert 'TEST_RUN_START' in text and 'TEST_RUN_END' in text, label
            states = {}
            for line in text.splitlines():
                fields = line.split(' | ')
                if len(fields) >= 4 and fields[1] in ('TEST_END', 'SUITE_END'):
                    states[(fields[0], fields[1])] = fields[3]
            tests = {key[0]: value for key, value in states.items() if key[1] == 'TEST_END'}
            assert len(tests) >= {'watch': 200, 'compiler': 20, 'multi': 3}[suite], (label, len(tests))
            failures = sorted(key[0] for key, value in states.items() if value == 'fail')
            code = int((root / f'{label}.exit').read_text())
            if code:
                assert failures, f'Unclassified runner error: {label}'
            log = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', (root / f'{label}.log').read_text())
            assert not re.search(r'error TS\d+', log), label
            summary[label] = {'exit': code, 'tests': len(tests), 'passed': sum(v == 'pass' for v in tests.values()), 'failed': sum(v == 'fail' for v in tests.values()), 'failures': failures}
(root / 'suite-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
for repeat in (1, 2):
    for suite in ('watch', 'compiler', 'multi'):
        normal = summary[f'{suite}-normal-{repeat}']['failures']
        forced = summary[f'{suite}-forced-{repeat}']['failures']
        extra = sorted(set(forced) - set(normal))
        assert not extra, f'ESCALATION forced-only failures: {extra}'
        unexpected = [name for name in normal if not re.search(r'loader-cache(?:-content-type)?(?:/| >|$)', name)]
        assert not unexpected, f'Unexpected normal failures: {unexpected}'
print(json.dumps(summary, indent=2))
print('Both forced passes have no additional failures.')
