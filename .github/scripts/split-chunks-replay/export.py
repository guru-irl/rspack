import hashlib
import json
import os
import shutil
import tarfile
from pathlib import Path

root = Path('bench-data')
pack = root / 'pack'
results = root / 'results'
delivery = root / 'delivery'
assert not delivery.exists(), 'Refuse to overwrite a delivery'
delivery.mkdir()
files = ['rspack.linux-x64-gnu.node', 'rspack-binding-linux-x64-gnu-2.2.9.tgz', 'rspack-core-2.2.9.tgz', 'rspack-binding-2.2.9.tgz']
sha = lambda data: hashlib.sha256(data).hexdigest()
native_sha = sha((pack / files[0]).read_bytes())
with tarfile.open(pack / 'rspack-core-2.2.9.tgz') as archive:
    package = json.load(archive.extractfile('package/package.json'))
    assert package['name'] == '@rspack/core' and package['version'] == '2.2.9'
    entry = package.get('exports', {}).get('.', package.get('main'))
    while isinstance(entry, dict):
        entry = entry.get('node', entry.get('require', entry.get('default')))
    assert isinstance(entry, str) and not entry.startswith('/') and '..' not in entry.split('/')
    entry = entry.removeprefix('./')
    core_sha = sha(archive.extractfile('package/' + entry).read())
assert core_sha == sha(Path('packages/rspack', entry).read_bytes()), 'Packaged core differs from tested core'
with tarfile.open(pack / 'rspack-binding-linux-x64-gnu-2.2.9.tgz') as archive:
    assert native_sha == sha(archive.extractfile('package/rspack.linux-x64-gnu.node').read())
rows = {}
for arm in ('OFF', 'ON'):
    folder = results / 'parity' / arm
    identities = [json.loads(line) for line in (folder / 'native.jsonl').read_text().splitlines()]
    assert identities and all(row['sha256'] == native_sha and len(row['mapped']) == 1 for row in identities)
    core = json.loads((folder / 'core-entry.json').read_text())
    assert core['sha256'] == core_sha
    rows[arm] = json.loads((folder / 'builds.json').read_text())
source = (results / 'source.sha').read_text().strip()
run = os.environ['GITHUB_SERVER_URL'] + '/' + os.environ['GITHUB_REPOSITORY'] + '/actions/runs/' + os.environ['GITHUB_RUN_ID']
summary = json.loads((results / 'test-summary.json').read_text())
lines = []
for off, on in zip(rows['OFF'], rows['ON'], strict=True):
    assert off['step'] == on['step']
    phase = lambda row: '; '.join(row['processCacheGroups']) or 'Skipped by replay'
    lines.append(f"| {off['step']} | {phase(off)} | {phase(on)} | {on['replay']} |")
readme = f'''# Rspack v2.2.9 hot replay pack

This pack adds opt-in SplitChunks replay to v2.2.9-hot. With the option off and the environment override unset, it uses the v2.2.9-hot algorithm.

- Source commit: `{source}`.
- Build and verification: {run}.
- Native SHA-256: `{native_sha}`.
- Core entry `{entry}` inside `rspack-core-2.2.9.tgz`, SHA-256: `{core_sha}`.

## Enable replay

Set `optimization.splitChunks.experimentalReplay: true` in development mode. The default is false. Alternatively, set `RSPACK_SPLIT_CHUNKS_REPLAY=1` to enable every SplitChunks instance in development mode. `strict` also includes module sizes in the entry digest. `force` enables replay in other modes too and is for tests only. The variable is read when the plugin is constructed.

Once per compilation, the SplitChunks logger reports `replay: replayed N operations (M chunks created) in t ms` or `replay: full run (reason; digest d ms)`. Replay timing includes the digest, pre-check, event application and max-size settings reconstruction. It excludes the following max-size splitting phase, which has its own timer. Full-run lines report digest overhead even on a miss. Disabled runs compute no digest and record no events.

## Opt-in contract

The `test`, `name` and `chunks` callback results must depend only on module identity, such as resource, request, type and layer, and on the chunk graph, such as module chunks, chunk names and runtime. Callbacks must not depend on source contents, invocation counts, mutable external state or sizes. Layer selectors must depend only on module layer. Replay skips cache-group preparation callbacks. The following max-size pass still calls function-valued fallback chunk filters, even if no maximum size is configured, as it does on a full run.

Sizes are excluded unless `strict` is selected. Therefore minSize, minSizeReduction and enforceSizeThreshold decisions use the last full run's sizes until the next topology change. This is intentional size drift. maxSize splitting always uses current sizes. Strict mode includes current sizes and falls back when they change.

The record is process-local and belongs to a plugin instance. Missing records, changed inputs, failed pre-checks and entry errors cause a full run. A full run that emits a diagnostic does not publish a record. Replay allocates fresh chunk keys and emits the same chunk mutations through the plugin's helpers.

## Verification

All five fixture steps have byte-identical emitted file names and contents with replay ON and OFF. Each arm uses one watch process, development mode and the same native file. Native identity was checked against `/proc/self/maps`. The fixture is the public program-native fixture at `a4ca7fd6ff8bc31a48de4ef91922fcb1af1e53dc`, with function test/name/chunks selectors and `[name].cjs` / `[name].[id].cjs` output names.

| Step | Replay OFF process cache groups | Replay ON process cache groups | Replay ON decision |
| --- | --- | --- | --- |
{chr(10).join(lines)}

Normal watch totals: `{json.dumps(summary['normal']['totals'], sort_keys=True)}`. Forced watch totals: `{json.dumps(summary['forced']['totals'], sort_keys=True)}`. There are no forced-only failed test or suite IDs. SplitChunks config cases and the replay watch cases passed. Shared watch failures, if any, remain failures and appear in the verification evidence.

These are phase timings from a correctness check, not a speedup or memory claim. This pack has Linux GNU artifacts only. The official 2.2.9 wrapper is included because its runtime files match the source. Install the core, wrapper and GNU binding tarballs together. The bare native file is also included for explicit binding selection.

Run `sha256sum -c SHA256SUMS` before use. The manifest covers this README and all four payloads.
'''
for name in files:
    shutil.copyfile(pack / name, delivery / name)
(delivery / 'README.md').write_text(readme)
manifest = ''.join(f'{sha(path.read_bytes())}  {path.name}\n' for path in sorted(delivery.iterdir()))
(delivery / 'SHA256SUMS').write_text(manifest)
(results / 'delivery-identities.json').write_text(json.dumps({'source': source, 'run': run, 'nativeSha256': native_sha, 'coreEntry': entry, 'coreEntrySha256': core_sha, 'sha256sumsSha256': sha(manifest.encode())}, indent=2) + '\n')
print((results / 'delivery-identities.json').read_text())
