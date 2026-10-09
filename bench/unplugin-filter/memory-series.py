import json
import pathlib
import shutil
import sys
from series import run, rows, root, results, verify_hashes

mode = sys.argv[1]
assert mode in ['fixed-young', 'watch']
arms = ['U0', 'U0prime', 'U2r2']
orders = [arms, ['U0prime', 'U2r2', 'U0'], ['U2r2', 'U0', 'U0prime'], list(reversed(arms)), ['U0', 'U2r2', 'U0prime']]
for rep in range(1, 6):
    for variant in (['broad', 'narrow'] if rep % 2 else ['narrow', 'broad']):
        triple = {}
        for arm in orders[rep - 1]:
            phase = 'cold' if mode == 'fixed-young' else 'watch'
            tag = f'm{rep}'
            flags = ['--min-semi-space-size=16', '--max-semi-space-size=16'] if mode == 'fixed-young' else []
            result = run(arm, variant, phase, tag, control='gc' if mode == 'fixed-young' else False, flags=flags, series=mode)
            assert result['node_options'] == ''
            assert result['exec_argv'] == ['--expose-gc', *flags]
            assert result['post_gc'] is not None
            if mode == 'watch':
                assert len(result['points']) == 6
                assert all(result['identity'][kind]['hook_count'] == 1 for kind in ['transform', 'load'])
            triple[arm] = result
            shutil.rmtree(root / 'cache' / f'{variant}-{arm}-{tag}')
        if mode == 'fixed-young':
            for field in ['counts', 'output_sha256', 'attachment_sha256', 'attached_modules']:
                assert all(triple[arm][field] == triple['U0'][field] for arm in arms), field
        else:
            for index in range(6):
                for field in ['counts', 'output_sha256']:
                    assert all(triple[arm]['points'][index][field] == triple['U0']['points'][index][field] for arm in arms), (index, field)
            for field in ['started', 'completed']:
                assert all(triple[arm]['loader'][field] == triple['U0']['loader'][field] for arm in arms), field
assert len(rows) == 30
verify_hashes()
(results / 'memory-parity.json').write_text(json.dumps({'mode': mode, 'samples': 30, 'replicates': 5, 'arms': arms, 'output_and_work_identical': True, 'fixed_young_mib': 16 if mode == 'fixed-young' else None, 'watch_schedule': {'initial_idle_s': 10, 'rebuilds': 5, 'gap_s': 3, 'final_idle_s': 10} if mode == 'watch' else None}, indent=2))
print('All memory triples and integrity checks passed')
