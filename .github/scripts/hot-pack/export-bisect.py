import hashlib
import json
import os
import shutil
import tarfile
from pathlib import Path

root = Path('bench-data')
arms = {
    'P5': ('91246a0627ef336f76a34b53c77d82801f3ee82a', '#27, rspack#16069, rspack#16070, #23, no SplitChunks PRs'),
    'P6': ('4ee64cbd79c65874acfdc672c937f8fee72c2d35', 'P5 + #37'),
    'P7': ('aaf6befd70cf10a156ababe9fddb05bdba25eb27', 'P6 + #38'),
    'P8': ('4346a48383c9478dbde5f02d9004ba4480cc92ba', 'P7 + #39'),
}
files = ['rspack-core-2.2.9.tgz', 'rspack-binding-2.2.9.tgz', 'rspack-binding-linux-x64-gnu-2.2.9.tgz', 'rspack.linux-x64-gnu.node']
sha = lambda data: hashlib.sha256(data).hexdigest()
delivery = root / 'delivery'
assert not delivery.exists(), 'Refuse to overwrite a delivery'
delivery.mkdir()
hashes = {}
smokes = {}
images = []
for arm, (source, _) in arms.items():
    evidence = root / 'evidence' / f'bisect-{arm}-evidence'
    pack = root / 'packages' / f'bisect-{arm}-packages'
    assert (evidence / 'source.sha').read_text().strip() == source
    images.append((evidence / 'runner-image.txt').read_text())
    native = (pack / files[-1]).read_bytes()
    native_sha = sha(native)
    core_sha = (evidence / 'built-core.sha256').read_text().split()[0]
    for filename, name in zip(files[:-1], ['@rspack/core', '@rspack/binding', '@rspack/binding-linux-x64-gnu']):
        with tarfile.open(pack / filename) as tf:
            metadata = json.load(tf.extractfile('package/package.json'))
            assert metadata['version'] == '2.2.9' and metadata['name'] == name
            if name == '@rspack/core':
                assert sha(tf.extractfile('package/dist/index.js').read()) == core_sha
            elif name == '@rspack/binding':
                assert sha((pack / filename).read_bytes()) == '04e1989833d4077e64a1a8569a68119a7633c2bb4be7e5759dab4e6f0d70e116'
            else:
                assert tf.extractfile('package/rspack.linux-x64-gnu.node').read() == native
    smoke = json.loads((evidence / 'smoke.json').read_text())
    assert smoke['step'] == 'cold' and smoke['chunkCount'] > 1
    assert smoke['nativeSha256'] == native_sha and len(smoke['mapped']) == 1
    assert smoke['mapped'][0] in (evidence / 'native.maps').read_text()
    assert all(smoke['callbacks'][key] > 0 for key in ('test', 'name', 'chunks'))
    identities = [json.loads(line) for line in (evidence / 'native.jsonl').read_text().splitlines()]
    assert identities and all(row['sha256'] == native_sha and row['mapped'] == smoke['mapped'] for row in identities)
    smokes[arm] = smoke
    (delivery / arm).mkdir()
    for filename in files:
        shutil.copyfile(pack / filename, delivery / arm / filename)
        hashes[f'{arm}/{filename}'] = sha((delivery / arm / filename).read_bytes())
assert len(set(images)) == 1
assert len({smoke['nativeSha256'] for smoke in smokes.values()}) == 4
run = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
readme = f'''# Rspack v2.2.9 prefix pack

This unreleased Linux x64 GNU pack contains four exact prefixes of `pack/v2.2.9-hot`. All packages retain version 2.2.9. The full pack at `b6703e272dbc52294d745073c7f00c3a838989c2` is P8 plus #40 and is not rebuilt here.

## Sources

| Arm | Commit | Contents on top of v2.2.9 |
| --- | --- | --- |
{chr(10).join(f'| {arm} | `{source}` | {contents} |' for arm, (source, contents) in arms.items())}

## Build settings

All four bindings and cores were built in one [GitHub run]({run}). Every build used ubuntu-22.04 image `{images[0].strip().replace(chr(10), ' / ')}`, Rust nightly-2026-04-16 with rust-src, clang 14, Node 22.23.3 and pnpm 11.26.0. Each release target was fresh and no Rust cache was restored.

The build command was:

```sh
RUST_TARGET=x86_64-unknown-linux-gnu USE_NAPI_CROSS=1 TARGET_CC=clang pnpm run build:binding:release
```

The official release helper supplied `--no-default-features --features plugin,info-level`, `-Zbuild-std=panic_abort,std`, `-Zlocation-detail=none` and `-Cforce-unwind-tables=no`. The release profile uses optimization level 3, fat LTO, one codegen unit, panic abort and stripping. `CARGO_INCREMENTAL=0` and `trim-paths = true` were set. Each core was rebuilt with `pnpm run build:js` and packed from its own source.

Runner setup pins the root `packageManager` and `engines.pnpm` metadata to 11.26.0 instead of 11.28.5, as in the delivered full pack. It does not alter runtime sources or package versions. `.npmrc`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` are unchanged.

Each arm's wrapper runtime files match v2.2.9 and the official wrapper package byte for byte. Every arm therefore ships the official 2.2.9 wrapper. Each GNU tarball contains the same native bytes as its arm's bare file. Each core tarball contains the rebuilt `dist/index.js` recorded in that arm's evidence.

## Install one arm

Use a separate installation for each arm. Do not mix the core or native package from different arms.

1. Set `PACK` to this directory's absolute path and verify the manifest:

```sh
cd "$PACK"
sha256sum -c SHA256SUMS
```

2. Return to the consuming project and choose `P5`, `P6`, `P7` or `P8`:

```sh
ARM=P5
pnpm add --save-exact "$PACK/$ARM/rspack-core-2.2.9.tgz" "$PACK/$ARM/rspack-binding-2.2.9.tgz" "$PACK/$ARM/rspack-binding-linux-x64-gnu-2.2.9.tgz"
```

For a workspace with transitive Rspack pins, override all three packages to the selected arm's absolute `file:` tarball paths at the workspace root, then reinstall. Confirm that the consuming process resolves this core and wrapper rather than another nested copy.

The bare native file is byte-identical to the corresponding GNU tarball payload. To select it explicitly in a fresh process:

```sh
export RSPACK_BINDING="$PACK/$ARM/rspack.linux-x64-gnu.node"
```

`RSPACK_BINDING` is specific to this rebuilt core. Avoid a global `NAPI_RS_NATIVE_LIBRARY_PATH` override because unrelated N-API packages can also read that variable. Check the native file actually loaded by the workload, not only the installed package path. The verification processes checked its SHA-256 and `/proc/self/maps`.

## Cold smoke results

Each arm completed one cold development build of the public `bench/program-native` fixture at `a4ca7fd6ff8bc31a48de4ef91922fcb1af1e53dc`, using the delivered pack's SplitChunks `test`, `name` and `chunks` callback configuration. All builds had zero errors. Each process checked the native file selected from `/proc/self/maps`. No test suite, rebuild or parity job ran.

| Arm | Chunks | Native SHA-256 | Warnings |
| --- | ---: | --- | ---: |
{chr(10).join(f"| {arm} | {row['chunkCount']} | `{row['nativeSha256']}` | {len(row['warnings'])} |" for arm, row in smokes.items())}

The chunk counts describe this public fixture only. They are not an output-parity result or a performance measurement.

## Payload SHA-256 values

| File | SHA-256 |
| --- | --- |
{chr(10).join(f'| `{name}` | `{digest}` |' for name, digest in sorted(hashes.items()))}

`SHA256SUMS` covers these 16 payloads and this README. It records the README checksum outside this file to avoid a self-referential checksum. The manifest does not cover itself. Build settings, source SHAs, logs, package identities, process maps and smoke results are retained in the run artifacts.
'''
assert all(chr(code) not in readme for code in (0x2014, 0x201C, 0x201D))
(delivery / 'README.md').write_text(readme)
covered = sorted(file for file in delivery.rglob('*') if file.is_file())
(delivery / 'SHA256SUMS').write_text(''.join(f'{sha(file.read_bytes())}  {file.relative_to(delivery).as_posix()}\n' for file in covered))
summary = {'run': run, 'workflowSha': os.environ['GITHUB_SHA'], 'sources': {arm: source for arm, (source, _) in arms.items()}, 'runnerImage': images[0].splitlines(), 'payloadHashes': hashes, 'readmeSha256': sha((delivery / 'README.md').read_bytes()), 'manifestSha256': sha((delivery / 'SHA256SUMS').read_bytes()), 'smokes': smokes}
(root / 'results/summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
