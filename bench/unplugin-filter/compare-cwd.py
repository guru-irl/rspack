import json
import pathlib
import sys

root = pathlib.Path('results')
stock = json.loads((root / 'cwd-U0.json').read_text())
right = sys.argv[1] if len(sys.argv) > 1 else 'U2r2'
patched = json.loads((root / f'cwd-{right}.json').read_text())
expected = [{kind: [f'{cwd}/src/accepted.ts'] for kind in ['load', 'transform']} for cwd in ['a', 'b']]
assert [row['accepted'] for row in stock['rows']] == expected, 'Stock check must exercise the changed cwd'
assert [row['accepted'] for row in patched['rows']] == expected, 'U2 cwd filter parity mismatch'
assert [row['rule_accepted'] for row in stock['rows']] == expected, 'Stock reused rule check must exercise the changed cwd'
assert [row['rule_accepted'] for row in patched['rows']] == expected, 'U2 cwd rule parity mismatch'
assert [row['built'] for row in stock['rows']] == [5, 5]
assert [row['built'] for row in patched['rows']] == [5, 5]
(root / ('cwd-parity.json' if right == 'U2r2' else f'cwd-parity-{right}.json')).write_text(json.dumps({'same_plugin_instance_and_reused_rule_callbacks': True, 'expected': expected, 'accepted_ids_identical': True}, indent=2))
print('Same-instance chdir accepted-id parity passed:', expected)
