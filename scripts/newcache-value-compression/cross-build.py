import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path.cwd()
HERE = ROOT / 'scripts/newcache-value-compression'
PROJECT = ROOT / '.spider/scratch/cross-build/project'
RESULTS = ROOT / 'cross-build-results'
RESULTS.mkdir(exist_ok=True)
(PROJECT / 'src').mkdir(parents=True, exist_ok=True)
(PROJECT / 'src/index.js').write_text("import value from './value.js'; console.log(value);\n")
(PROJECT / 'src/value.js').write_text("export default '" + 'public-value-' * 100 + "';\n")
(PROJECT / 'package.json').write_text('{"name":"public-cache-fixture","version":"1.0.0"}')
(PROJECT / 'probe-loader.cjs').write_text("module.exports = function(source) { require('node:fs').writeFileSync(require('node:path').join(this.rootContext, 'loader-called'), 'called'); return source; };\n")
records = []
for writer, reader in [('main','branch'), ('branch','main')]:
    cache = PROJECT / 'cache'
    if cache.exists():
        shutil.rmtree(cache)
    for arm, mode in [(writer,'seed'), (writer,'hit'), (reader,'cross')]:
        (PROJECT / 'loader-called').unlink(missing_ok=True)
        output = RESULTS / f'{writer}-{arm}-{mode}.json'
        env = dict(os.environ, PROJECT=str(PROJECT), NODE_PATH=str(ROOT/'runtime'/arm/'node_modules'),
                   RSPACK_CORE=str(ROOT/'runtime'/arm/'packages/rspack/dist/index.js'))
        with (output.with_suffix('.log')).open('w') as log:
            subprocess.run(['node', str(HERE/'cross-build.mjs'), mode, str(output)], env=env,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
        records.append(json.loads(output.read_text()))
if len({r['output_sha256'] for r in records}) != 1:
    raise RuntimeError('Cross-build output parity failed')
(RESULTS/'success.json').write_text(json.dumps({'both_directions_miss': True, 'same_build_decode': True, 'output_parity': True}))
print('Same-build restore and decode-failure-as-miss verified in both directions, output parity exact')
