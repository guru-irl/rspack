import json
import pathlib

root = pathlib.Path('results')
stock = json.loads((root / 'cwd-U0.json').read_text())
patched = json.loads((root / 'cwd-U2.json').read_text())
expected = [{kind: [f'{cwd}/src/accepted.ts'] for kind in ['load', 'transform']} for cwd in ['a', 'b']]
assert [row['accepted'] for row in stock['rows']] == expected, 'Stock check must exercise the changed cwd'
assert [row['accepted'] for row in patched['rows']] == expected, 'U2 cwd filter parity mismatch'
assert [row['built'] for row in stock['rows']] == [5, 5]
assert [row['built'] for row in patched['rows']] == [5, 5]
(root / 'cwd-parity.json').write_text(json.dumps({'same_compiler_and_plugin_instance': True, 'expected': expected, 'accepted_ids_identical': True}, indent=2))
print('Same-instance chdir accepted-id parity passed:', expected)
