import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path.cwd()
bindings = list((root / 'crates/node_binding').glob('*.node'))
if len(bindings) != 1:
    raise RuntimeError(f'Expected one native binding, got {bindings}')
manifest = {
    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'binding_sha256': hashlib.sha256(bindings[0].read_bytes()).hexdigest(),
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'rust': subprocess.check_output(['rustc', '--version'], text=True).strip(),
    'profile': 'release, fat LTO, opt-level=3, codegen-units=1, panic=abort',
    'features': ['plugin', 'info-level'],
    'unwind_tables': False,
    'binding_bytes': bindings[0].stat().st_size,
    'allocator': 'Repository default native allocator; unchanged between arms',
}
(root / 'bundle/build.json').write_text(json.dumps(manifest, indent=2))
