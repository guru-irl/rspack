import fnmatch
import json
import re
import subprocess
from pathlib import Path

root = Path('bench-data')
evidence = root / 'evidence'
source = (evidence / 'hot-TREATMENT-evidence/source.sha').read_text().strip()
files = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', source, '--', 'tests/rspack-test/configCases', 'tests/rspack-test/watchCases'], text=True).splitlines()
case_dirs = {'/'.join(file.split('/')[2:5]) for file in files if len(file.split('/')) >= 6}
requested = {
    '#27': ['watchCases/devtools/cheap-module-cached-replay'],
    'rspack#16069': ['watchCases/module-ids/deterministic-content-only-incremental', 'watchCases/module-ids/deterministic-collision-precise-invalidation'],
    'rspack#16070': ['watchCases/chunk-ids/deterministic-content-only-incremental', 'watchCases/chunk-ids/deterministic-collision-precise-invalidation', 'watchCases/chunk-ids/deterministic-group-membership'],
    '#23': ['configCases/compilation/chunk-collection-snapshots'],
    '#37': ['configCases/split-chunks/cache-group-layer-native', 'configCases/split-chunks/module-type-filter', 'configCases/css-extract/module-layer', 'configCases/layer/define-single-entry', 'configCases/layer/define-multiple-entries'],
    '#38': ['configCases/split-chunks/callback-order', 'configCases/split-chunks/batch-functions', 'configCases/split-chunks/module-type-filter', 'configCases/split-chunks/cache-group-layer-function', 'configCases/split-chunks/priority-residual-*', 'configCases/split-chunks/intersections-*'],
    '#39': ['configCases/split-chunks/batch-functions', 'configCases/split-chunks/batch-name-output-order', 'configCases/split-chunks/callback-order', 'configCases/split-chunks/cache-group-name-add-chunks-cachegroupkey', 'configCases/split-chunks/cache-group-name-function-with-error'],
    '#40': ['configCases/split-chunks/callback-order', 'configCases/split-chunks/batch-functions', 'configCases/split-chunks/batch-name-output-order', 'configCases/split-chunks/chunks-function', 'configCases/split-chunks/cache-group-name-add-chunks-cachegroupkey', 'configCases/split-chunks/chunks-function-with-error', 'configCases/split-chunks/cache-group-name-function-with-error', 'configCases/split-chunks/priority-residual-*', 'configCases/split-chunks/intersections-*', 'configCases/split-chunks/dedup-depth', 'configCases/split-chunks/module-type-filter', 'configCases/split-chunks/cache-group-layer-function', 'configCases/split-chunks/cache-group-layer-native'],
}
statuses = {}
for arm in ('CONTROL', 'TREATMENT'):
    rows = {}
    report = evidence / f'hot-{arm}-evidence/rspack-test-event-report.txt'
    text = report.read_text()
    assert 'TEST_RUN_END' in text, arm
    for line in text.splitlines():
        fields = line.split(' | ')
        if len(fields) >= 4 and fields[1] == 'TEST_END':
            rows[fields[0]] = fields[3]
    statuses[arm] = rows
new_ids = sorted(set(statuses['TREATMENT']) - set(statuses['CONTROL']))
assert new_ids and all(statuses['TREATMENT'][key] == 'pass' for key in new_ids), 'A treatment-added test did not pass'
audit = {'source': source, 'newTestIds': new_ids, 'newTestCount': len(new_ids), 'prs': {}}
for pr, patterns in requested.items():
    expanded = set()
    for pattern in patterns:
        matches = {case for case in case_dirs if fnmatch.fnmatchcase(case, pattern)}
        assert matches, f'Case pattern absent from source: {pr}/{pattern}'
        expanded.update(matches)
    results = []
    for case in sorted(expanded):
        matches = {key: state for key, state in statuses['TREATMENT'].items() if re.search(re.escape(case) + r'(?=[ >\[/]|$)', key)}
        assert matches, f'Case did not execute: {pr}/{case}'
        assert all(state == 'pass' for state in matches.values()), f'Case did not pass: {pr}/{case}: {matches}'
        results.append({'case': case, 'passedTestContexts': len(matches), 'testIds': sorted(matches)})
    audit['prs'][pr] = results
    print(pr, ':', ', '.join(f"{row['case']} ({row['passedTestContexts']} passed)" for row in results))
(root / 'results/case-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
print('Treatment-added test IDs:', len(new_ids), '; all passed')
