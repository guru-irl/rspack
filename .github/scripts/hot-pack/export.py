import hashlib
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path
from compare import compare

root = Path('bench-data')
base = '428b70684309de4068e32baf81d28194441dd64e'
head = 'b6703e272dbc52294d745073c7f00c3a838989c2'
sha = lambda data: hashlib.sha256(data).hexdigest()
summary = json.loads((root / 'results/test-summary.json').read_text())
assert not summary['treatmentOnlyFailures']
assert summary['failedTestIdSetsIdentical']
case_audit = json.loads((root / 'results/case-audit.json').read_text())
assert case_audit['source'] == head and case_audit['newTestCount'] == 43
assert (root / 'results/output-parity.txt').is_file()
images = [(root / 'evidence' / f'hot-{arm}-evidence/runner-image.txt').read_text() for arm in ('CONTROL', 'TREATMENT')]
assert images[0] == images[1]
delivery = root / 'delivery'
assert not delivery.exists(), 'Refuse to overwrite a delivery'
delivery.mkdir()
packages = ['rspack-core-2.2.9.tgz', 'rspack-binding-2.2.9.tgz', 'rspack-binding-linux-x64-gnu-2.2.9.tgz', 'rspack.linux-x64-gnu.node']
payload_hashes = {}
parity = {}
for arm, source in [('CONTROL', base), ('TREATMENT', head)]:
    evidence = root / 'evidence' / f'hot-{arm}-evidence'
    assert (evidence / 'source.sha').read_text().strip() == source
    pack = root / 'packages' / f'hot-{arm}-packages'
    native = (pack / packages[-1]).read_bytes()
    assert sha(native) == summary[arm]['nativeSha256']
    built_core = (evidence / 'built-core.sha256').read_text().split()[0]
    for filename in packages[:-1]:
        with tarfile.open(pack / filename) as tf:
            metadata = json.load(tf.extractfile('package/package.json'))
            assert metadata['version'] == '2.2.9'
            if filename == packages[0]:
                assert metadata['name'] == '@rspack/core'
                assert sha(tf.extractfile('package/dist/index.js').read()) == built_core
            elif filename == packages[1]:
                assert metadata['name'] == '@rspack/binding'
                assert sha((pack / filename).read_bytes()) == '04e1989833d4077e64a1a8569a68119a7633c2bb4be7e5759dab4e6f0d70e116'
            else:
                assert metadata['name'] == '@rspack/binding-linux-x64-gnu'
                assert tf.extractfile('package/rspack.linux-x64-gnu.node').read() == native
    for variant in ('deterministic', 'split-chunks'):
        result = root / 'results' / variant / arm
        rows = json.loads((result / 'builds.json').read_text())
        steps = ['cold', 'rebuild', 'add-module'] if variant == 'deterministic' else ['cold', 'rebuild']
        assert [row['step'] for row in rows] == steps
        identities = [json.loads(line) for line in (result / 'native.jsonl').read_text().splitlines()]
        assert identities and all(row['sha256'] == sha(native) and row['mapped'] == [row['path']] for row in identities)
        assert all(row['path'] in (result / 'native.maps').read_text() for row in identities)
        try:
            compare(result / 'cold', result / 'rebuild')
        except AssertionError:
            pass
        else:
            raise AssertionError('The source edit did not change emitted bytes')
        if variant == 'deterministic':
            assert rows[2]['chunkCount'] > rows[1]['chunkCount']
            try:
                compare(result / 'rebuild', result / 'add-module')
            except AssertionError:
                pass
            else:
                raise AssertionError('The new module and import did not change emitted bytes')
        for step in steps:
            compare(root / 'results' / variant / 'CONTROL' / step, root / 'results' / variant / 'TREATMENT' / step)
        parity[f'{variant}/{arm}'] = {'nativeSha256': sha(native), 'rows': rows}
    (delivery / arm).mkdir()
    for filename in packages:
        shutil.copyfile(pack / filename, delivery / arm / filename)
        payload_hashes[f'{arm}/{filename}'] = sha((pack / filename).read_bytes())
assert summary['CONTROL']['nativeSha256'] != summary['TREATMENT']['nativeSha256']

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

commits = git('rev-list', '--reverse', f'{base}..{head}').splitlines()
assert len(commits) == 8
pr_rows = []
for commit in commits:
    subject = git('show', '-s', '--format=%s', commit)
    body = git('show', '-s', '--format=%b', commit)
    trailers = dict(line.split(': ', 1) for line in body.splitlines() if line.startswith(('Source-PR: ', 'Source-head: ', 'Source-base: ')))
    assert len(trailers) == 3
    pr_rows.append(f"| [{subject}]({trailers['Source-PR']}) | `{trailers['Source-head']}` | `{commit}` |")
run_url = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['SOURCE_RUN_ID']}"
verification_url = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
readme = f'''# Rspack v2.2.9 hot-reload comparison pack

This Linux x64 GNU pack compares hot-reload behavior and time with eight performance PRs against plain v2.2.9. It is an unreleased diagnostic build. All packages retain version 2.2.9.

CONTROL is plain v2.2.9 at `{base}`. TREATMENT is `{head}` on `pack/v2.2.9-hot`.

Both arms rebuilt the native binding and core from their own source and ran the suites in one [GitHub run]({run_url}). [Classification, parity and export]({verification_url}) reuse that run's frozen packages and reports; the suites were not rerun. The wrapper runtime files are identical between arms and match the official package. Both arms therefore ship the official 2.2.9 wrapper, not a rebuilt wrapper. Added native exports are returned directly by that unchanged wrapper.

## Included PRs

Each PR is one commit, applied in this order. The deterministic chunk-ID commit combines both ID changes in the three documented conflict files.

| PR and title | Original head | Pack commit |
| --- | --- | --- |
{chr(10).join(pr_rows)}

## Settings that activate the changes

- #27 applies to repeated final line-only source-map reads, such as `devtool: 'cheap-module-source-map'` during rebuilds. No new option is required.
- #16069 applies to incremental rebuilds with `optimization.moduleIds: 'deterministic'`.
- #16070 applies to incremental rebuilds with `optimization.chunkIds: 'deterministic'`.
- #23 applies when JavaScript integrations repeatedly read chunk or chunk-group collections. No new option is required.
- #37 keeps SplitChunks cache-group `type` and `layer` filters native. Configure those filters where appropriate.
- #38 batches function-valued SplitChunks cache-group `test` callbacks. No new option is required.
- #39 increases batching for function-valued SplitChunks `name` callbacks. No new option is required.
- #40 processes SplitChunks callback combinations in bounded rounds. It applies to the callback path without a new option.

Use development/watch mode with incremental compilation enabled to exercise the rebuild changes. Keep the workload, edit, options and process environment identical between arms.

With a progress plugin enabled, rspack#16069 adds one scan over all modules on every rebuild before module IDs are assigned. Output is unchanged. Keep the progress setting identical between arms. The parity runs enable no progress plugin in either arm.

## Left out

- rspack#16129 has a smaller measured rebuild gain than the #37 chain and conflicts with #37.
- #29 conflicts with #37 through #40 in `module_group.rs`.
- #45 depends on upstream #15754, which is not in 2.2.9.
- #43 can assign different watch-mode IDs than a fresh build.
- #5 fixes watch correctness without a time effect.
- #24 and #25, and #6 and #26, are closed and replaced by the included PRs.
- #30, #35, #19, #11 and rspack#16076 change correctness or emitted output.
- #44, #46, #47, #15, #16, #28, rspack#16049, rspack#16077 and rspack#16127 affect cold start or cache only.

## Build settings

Both native builds used the same ubuntu-22.04 image, `{images[0].strip().replace(chr(10), ' / ')}`, Rust nightly-2026-04-16 with rust-src, clang 14, Node 22.23.3 and pnpm 11.26.0. Each release target was fresh. No Rust cache was restored. Runner setup pins the root `packageManager` and `engines.pnpm` metadata to 11.26.0 instead of the source tag's 11.28.5. That setup change does not alter package runtime sources or package versions.

The build command was:

```sh
RUST_TARGET=x86_64-unknown-linux-gnu USE_NAPI_CROSS=1 TARGET_CC=clang pnpm run build:binding:release
```

The official release helper supplied `--no-default-features --features plugin,info-level`, `-Zbuild-std=panic_abort,std`, `-Zlocation-detail=none` and `-Cforce-unwind-tables=no`. The release profile uses optimization level 3, fat LTO, one codegen unit, panic abort and stripping. `CARGO_INCREMENTAL=0` and `trim-paths = true` were set. Test-loader and profiling features were not enabled. Each core was built with `pnpm run build:js` and packed from that arm's source.

## Install one arm

Use a separate installation for each arm. Do not mix the core or native package from different arms.

1. Set `PACK` to this directory's absolute path and verify the manifest:

```sh
cd "$PACK"
sha256sum -c SHA256SUMS
```

2. Return to the consuming project and choose `CONTROL` or `TREATMENT`:

```sh
ARM=CONTROL
pnpm add --save-exact "$PACK/$ARM/rspack-core-2.2.9.tgz" "$PACK/$ARM/rspack-binding-2.2.9.tgz" "$PACK/$ARM/rspack-binding-linux-x64-gnu-2.2.9.tgz"
```

For a workspace with transitive Rspack pins, override all three packages to the selected arm's absolute `file:` tarball paths at the workspace root, then reinstall. Confirm that the consuming process resolves this core and wrapper rather than another nested copy.

The bare native file is byte-identical to the corresponding GNU tarball payload. To select it explicitly in a fresh process:

```sh
export RSPACK_BINDING="$PACK/$ARM/rspack.linux-x64-gnu.node"
```

`RSPACK_BINDING` is specific to this rebuilt core. Avoid a global `NAPI_RS_NATIVE_LIBRARY_PATH` override because unrelated N-API packages can also read that variable. Check the native file actually loaded by the workload, not only the installed package path. The verification processes checked its SHA-256 and `/proc/self/maps`.

## Payload SHA-256 values

| File | SHA-256 |
| --- | --- |
{chr(10).join(f'| `{name}` | `{digest}` |' for name, digest in sorted(payload_hashes.items()))}

The official published 2.2.9 native file has SHA-256 `6e791a118da96ece3fc1bb03b940772d3e141f47bbb3097fec36a097e7bded9c`. It is a reference, not a same-toolchain control.

## Verification summary

Both arms ran `pnpm run test:ci`, the Linux CI command at v2.2.9. CONTROL exited {summary['CONTROL']['ciExit']}, and TREATMENT exited {summary['TREATMENT']['ciExit']}.

| Arm | Passed tests | Failed tests | Skipped tests |
| --- | ---: | ---: | ---: |
| CONTROL | {summary['CONTROL']['primaryTestCounts'].get('passed', 0)} | {summary['CONTROL']['primaryTestCounts'].get('failed', 0)} | {summary['CONTROL']['primaryTestCounts'].get('skipped', 0)} |
| TREATMENT | {summary['TREATMENT']['primaryTestCounts'].get('passed', 0)} | {summary['TREATMENT']['primaryTestCounts'].get('failed', 0)} | {summary['TREATMENT']['primaryTestCounts'].get('skipped', 0)} |

The sets of failing test IDs are identical. There are zero treatment-only failed test, suite or file records. All 43 treatment-added test IDs passed. The audit also confirms every case named in the included PRs' test lists passed in TREATMENT, including the native layer filter case. Shared failures are not counted as passes.

Of the 30 failed tests, 27 need test-only builtin loaders, two need the test-only binding-builder plugin export, and one is `compilerCases/persistent-cache-issuer-updates`, which needs DEBUG trace events. The release profile omits those features. None of these failed IDs is an ID-allocation, SplitChunks, source-map or chunk-API case.

Separately, both arms failed to load `NativeWatcherIgnoredFunction.test.mjs`: the native-path guard rejected its direct source-tree binding path. That file's tests did not run. This shared harness limitation is not included in the 30 failed tests. The evidence retains the complete terminal summaries, raw event reports, equal failing-ID lists, per-PR case audit and failure messages.

The public `bench/program-native` fixture is pinned at `a4ca7fd6ff8bc31a48de4ef91922fcb1af1e53dc`. Each arm completed a cold build and a rebuild after one module content edit in development mode under two configurations. Both use deterministic module and chunk IDs. The second also uses function-valued SplitChunks `test`, `name` and `chunks` callbacks with a `javascript/auto` type filter. Both configurations use cheap module source maps. All requested callbacks executed.

The first configuration then completed a second rebuild in the same watch process. That rebuild added one module and a new `import()` in an existing module, and created an additional chunk. Emitted filenames and bytes match between arms after all three deterministic builds and both SplitChunks builds. Each edit changed the emitted bytes. Both arms use the development default incremental passes. The identical `silent: false` setting makes fallback diagnostics visible without changing those passes.

Each arm's warnings and logger output are retained per build in `warnings.json`. CONTROL is expected to report deterministic-ID incremental fallbacks and TREATMENT is expected not to. Warning differences are evidence of which paths ran, not a delivery gate.

The comparator rejected seeded byte, missing-file, extra-file and missing-directory errors before comparing outputs. Every parity process recorded the selected native SHA-256 from its mapped file. Each GNU tarball's native payload matches its bare file. `readelf` confirms neither rebuilt binding requires a newer GLIBC version than the official binary.

Build logs, source SHAs, settings, runner images, GLIBC requirements and raw suite reports are retained in the build run's artifacts. Classification, case-audit records, process maps and parity outputs are retained in the verification run's artifacts. This pack establishes source provenance and correctness checks. It makes no performance or cross-platform memory claim.
'''
# Keep the distributed prose plain and generic.
assert all(chr(code) not in readme for code in (0x2014, 0x201C, 0x201D))
(delivery / 'README.md').write_text(readme)
files = sorted(file for file in delivery.rglob('*') if file.is_file())
(delivery / 'SHA256SUMS').write_text(''.join(f'{sha(file.read_bytes())}  {file.relative_to(delivery).as_posix()}\n' for file in files))
result = {'run': run_url, 'verificationRun': verification_url, 'source': {'CONTROL': base, 'TREATMENT': head}, 'runnerImage': images[0].splitlines(), 'payloadHashes': payload_hashes, 'manifestSha256': sha((delivery / 'SHA256SUMS').read_bytes()), 'tests': summary, 'parity': parity}
(root / 'results' / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: value for key, value in result.items() if key not in ('tests', 'parity')}, indent=2))
