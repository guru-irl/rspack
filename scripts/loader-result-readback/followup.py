import datetime
import hashlib
import json
import math
import os
import pathlib
import re
import subprocess
import sys

previous = '9029daa62b7baaf7b10e903e84d78f7aecb0dec9'
base = 'd9d09d4152cd15fc46eb5d1cb8d9b227bfcd39eb'
old_pr = 'aad661921bdd07380ad7cb9f2bf3debef2f210d7'
pr = 'c2b473322d3d6c1292f8a124cdc4206ce52b35e3'
root = pathlib.Path('bench-data/results')
scripts = pathlib.Path('scripts/loader-result-readback')

def git(*args):
    return subprocess.check_output(['git', *args], text=True)

def read_json(file):
    return json.loads(file.read_text())

def preflight():
    for file in ['scripts/program-native/prepare.mjs', 'scripts/loader-result-readback/exact.py']:
        assert git('show', f'{previous}:{file}') == pathlib.Path(file).read_text(), file
    file = 'scripts/loader-result-readback/summary.py'
    assert git('show', f'{previous}:{file}').replace(old_pr, pr) == pathlib.Path(file).read_text()
    file = 'scripts/program-native/run.mjs'
    normalized = pathlib.Path(file).read_text().replace("const purgeDelay = process.env.MIMALLOC_PURGE_DELAY ?? null;\n", '').replace("if (purgeDelay !== (process.env.EXPECTED_PURGE_DELAY === '0' ? '0' : null)) throw new Error('Unexpected process MIMALLOC_PURGE_DELAY');\n", '').replace('const result = {purgeDelay, bindingIdentity,', 'const result = {bindingIdentity,')
    assert normalized == git('show', f'{previous}:{file}'), 'Changed measurement instrumentation'
    file = 'scripts/loader-result-readback/pairs.mjs'
    expected = git('show', f'{previous}:{file}')
    expected = expected.replace("const results = path.resolve('bench-data/results');", "const phase = process.env.BENCH_PHASE;\nif (!['R', 'P'].includes(phase) || process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Expected macOS arm64 phase R or P');\nif (process.env.MIMALLOC_PURGE_DELAY !== undefined) throw new Error('Default runner environment already overrides MIMALLOC_PURGE_DELAY');\nconst results = path.resolve(`bench-data/results/${phase}`);")
    expected = expected.replace('platform: process.platform, blocks: 10, warmups:', "platform: process.platform, phase, purgeDelay: phase === 'P' ? '0' : null, blocks: 10, warmups:")
    expected = expected.replace('2026-10-19T00:35:00Z', '2026-10-19T00:40:00Z')
    expected = expected.replace("  const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=8192', 'scripts/program-native/run.mjs', root, resultPath], {encoding: 'utf8', timeout: 180000, env: {...process.env, EXPECTED_BINDING_SHA256: expected[arm]}});", "  const env = {...process.env, EXPECTED_BINDING_SHA256: expected[arm], EXPECTED_PURGE_DELAY: phase === 'P' ? '0' : 'unset'};\n  if (phase === 'P') env.MIMALLOC_PURGE_DELAY = '0';\n  const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=8192', 'scripts/program-native/run.mjs', root, resultPath], {encoding: 'utf8', timeout: 180000, env});")
    expected = expected.replace('  const files = JSON.stringify(result.outputFiles);', "  if (result.purgeDelay !== (phase === 'P' ? '0' : null)) throw new Error('Process purge-delay receipt mismatch');\n  const files = JSON.stringify(result.outputFiles);")
    assert expected == pathlib.Path(file).read_text(), 'Changed pair protocol beyond registered phases'
    expected_files = ['crates/rspack_binding_api/src/plugins/js_loader/mod.rs', 'crates/rspack_binding_api/src/plugins/js_loader/scheduler.rs', 'crates/rspack_napi/src/threadsafe_function.rs']
    assert git('diff', '--name-only', base, pr).splitlines() == expected_files
    print('PREFLIGHT_VERIFIED fixture=unchanged exact_inference=unchanged summary=SHA-only process=environment-receipt-only schedule=phase-environment-deadline-only')
    return expected_files

expected_files = preflight()
if '--preflight' in sys.argv:
    sys.exit(0)

assert os.environ.get('MIMALLOC_PURGE_DELAY') is None
run = read_json(root / 'run.json')
jobs = read_json(root / 'jobs.json')['jobs']
assert run['head_sha'] == os.environ['GITHUB_SHA']
assert run['head_branch'] == 'bench/single-wake-mac-followup'
assert len(jobs) == 1 and jobs[0]['name'] == 'Memory (macos-15)'
assert (root / 'source.diff').read_text() == git('diff', base, pr)
assert (root / 'actual-source-files.txt').read_text().splitlines() == expected_files
assert (root / 'expected-source-files.txt').read_text().splitlines() == expected_files
environment = read_json(root / 'environment.json')
assert (environment['platform'], environment['arch']) == ('darwin', 'arm64')
assert environment['mimallocEnvironment'].get('MIMALLOC_PURGE_DELAY') is None
for file, sha in environment['fixtureScripts'].items():
    assert hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest() == sha
identities = read_json(root / 'build-identities.json')
build_times = {}
for arm in ['base', 'pr']:
    log = (root / f'{arm}-build.log').read_text()
    assert 'Compiling rspack_binding_api' in log and 'Compiling rspack_napi' in log
    match = re.search(r'Finished [`\']?ci[`\']? profile.*optimized.* in (.+)', log)
    assert match, f'Wrong build profile: {arm}'
    build_times[arm] = match.group(1).strip()
summaries = {}
expected_output = [{'name': 'bundle.cjs', 'sha256': '07642bee7459d5745ba5bb7744f02bc0ef0c41ba3ff88ab866b52d676046cca3'}]
for phase in ['R', 'P']:
    results = root / phase
    saved = read_json(results / 'summary.json')
    saved_md = (results / 'summary.md').read_text()
    subprocess.run([sys.executable, str(scripts / 'summary.py'), str(results)], check=True)
    assert read_json(results / 'summary.json') == saved
    assert (results / 'summary.md').read_text() == saved_md
    assert saved['samples'] == 20 and saved['parity']['runs'] == 22
    assert saved['parity']['bindings'] == identities
    assert saved['parity']['files'] == expected_output
    protocol = read_json(results / 'protocol.json')
    assert protocol['phase'] == phase and protocol['blocks'] == 10
    assert protocol['purgeDelay'] == ('0' if phase == 'P' else None)
    assert protocol['warmups'] == ['base', 'pr']
    schedule = read_json(results / 'schedule.json')
    assert len(schedule) == 22
    for item in schedule:
        record = read_json(results / item['file'])
        assert record['purgeDelay'] == ('0' if phase == 'P' else None)
        assert record['steadyRss'] == record['snapshots']['end']['process']['rss']
        assert record['closeRss'] == record['snapshots']['close']['process']['rss']
        assert record['idleRss'] == record['snapshots']['postGc']['process']['rss']
        gc = record['gcActivity']
        assert sum(value['count'] for value in gc['byKind'].values()) == gc['count']
        assert math.isclose(sum(value['durationMs'] for value in gc['byKind'].values()), gc['durationMs'], rel_tol=1e-12, abs_tol=1e-9)
    summaries[phase] = saved

def metric(phase, key):
    return next(row for row in summaries[phase]['rows'] if row['metric'] == key)

replicates = any(metric('R', key)['increased'] for key in ['peakRss', 'snapshots.postGc.process.rss'])
p_increase = any(metric('P', key)['increased'] for key in ['peakRss', 'snapshots.postGc.process.rss'])
if not replicates:
    verdict = 'Not reproduced.'
    interpretation = 'Phase R does not reproduce the macOS arm64 RSS increase under the pre-registered rule. Neither peak nor post-GC RSS has an exact 95% interval lower bound above zero. The purge-delay explanation cannot be established from this follow-up.'
elif not p_increase:
    verdict = "Freed pages held by mimalloc's purge delay, not live memory."
    interpretation = 'Phase R replicates the RSS increase, and Phase P detects no increase in either peak or post-GC RSS. This is the pre-registered purge-delay case.'
else:
    verdict = 'Live native memory or a different retention.'
    interpretation = 'Phase R replicates the RSS increase, and Phase P still detects an increase in peak or post-GC RSS. This is the pre-registered persistent-increase case.'

text = f'# Single-wake macOS memory follow-up\n\n## Verdict\n\n{verdict}\n\n{interpretation}\n\n'
text += 'INCREASED means the exact 95% interval lower bound is strictly above zero. No increase detected does not prove equality. Results from the earlier run and this run are not pooled.\n\n'
primary = ['peakRss', 'snapshots.end.process.rss', 'snapshots.postGc.process.rss', 'snapshots.end.nativeEstimate', 'snapshots.postGc.nativeEstimate']
for snapshot in ['end', 'postGc']:
    primary.extend(f'snapshots.{snapshot}.v8.{field}' for field in ['used_heap_size', 'total_heap_size', 'total_physical_size', 'malloced_memory', 'external_memory'])
primary.append('buildMs')
for phase, label in [('R', 'default-environment replication'), ('P', 'MIMALLOC_PURGE_DELAY=0 in both arms')]:
    text += f'## Phase {phase}, {label}\n\n'
    text += '| Metric | Base median | PR median | Change | Paired median delta | HL delta | Exact 95% interval | Verdict |\n| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |\n'
    for key in primary:
        row = metric(phase, key)
        unit = row['unit']
        scale = 1024**2 if unit == 'MiB' else 1000 if unit == 's' else 1
        low, high = row['exact95']
        change = f"{row['percent']:+.2f}%" if row['percent'] is not None else 'n/a'
        text += f"| {row['label']} ({unit}) | {row['baseMedian']/scale:.3f} | {row['prMedian']/scale:.3f} | {change} | {row['pairedMedian']/scale:+.3f} | {row['hodgesLehmann']/scale:+.3f} | [{low/scale:+.3f}, {high/scale:+.3f}] | {'INCREASED' if row['increased'] else 'No increase detected'} |\n"
    additional = [row['label'] for row in summaries[phase]['rows'] if row['increased'] and row['metric'] not in primary]
    text += '\nAdditional detected increases outside this table: ' + (', '.join(additional) if additional else 'none') + '. Full snapshots and GC metrics are retained in the phase summary files.\n\n'

text += '''## Earlier run, kept separate

Run [39164758273](https://github.com/guru-irl/rspack/actions/runs/39164758273), macOS job 117785265200, measured candidate `aad661921bdd07380ad7cb9f2bf3debef2f210d7` against the same base. It detected the following RSS increases. Its Linux x64 and Windows x64 jobs detected no memory increase.

| Metric | Paired median delta MiB | HL delta MiB | Exact 95% interval MiB |
| --- | ---: | ---: | --- |
| Peak RSS | +28.625 | +29.930 | [+2.711, +68.195] |
| END RSS | +24.312 | +24.719 | [+2.938, +55.578] |
| Post-GC RSS | +28.609 | +28.234 | [+1.938, +41.312] |

The current head adds only error-path cleanup and a comment to that measured head. The success path is unchanged. This follow-up uses the exact new head rather than substituting the earlier binary.

## Run, source and native identity

'''
text += f"One measurement run [{run['id']}]({run['html_url']}), job [{jobs[0]['id']}]({jobs[0]['html_url']}). Workflow commit `{os.environ['GITHUB_SHA']}` on `bench/single-wake-mac-followup`.\n\n"
text += f'Base `{base}` versus PR head `{pr}`. The exact three-file gate, complete source-tree gates, recompilation of both changed Rust crates and generated-declaration gate passed. Both arms used `pnpm run build:binding:ci`, CARGO_INCREMENTAL=0 and CARGO_BUILD_JOBS=3. JavaScript artifacts were built once and shared. The same two native binaries were reused in both phases.\n\n'
text += '| Arm | Native SHA-256 | Native build elapsed |\n| --- | --- | --- |\n'
for arm in ['base', 'pr']:
    text += f"| {arm} | `{identities[arm]}` | {build_times[arm]} |\n"
text += f"\nHosted macos-15 arm64, Node {environment['node']}, {environment['os']}, release {environment['release']}, {environment['cpus'][0]['model']}, {len(environment['cpus'])} logical CPUs, {environment['ram']/1024**3:.2f} GiB RAM, image {environment['image']} / {environment['imageVersion']}. Evidence began {environment['started']}.\n\n"
text += 'Inherited MIMALLOC_ environment: `' + json.dumps(environment['mimallocEnvironment'], sort_keys=True) + '`. The default environment did not override MIMALLOC_PURGE_DELAY. Every Phase R receipt records null and every Phase P receipt records "0". The override was set only in each Phase P child environment, not during either build or in the phase driver.\n\n'
text += '''## Protocol and hosted verification

Each phase has two discarded warmups, base then PR, followed by ten alternating pairs, base first on odd pairs and PR first on even pairs. All 44 processes succeeded; 40 measured processes supply inference and all four warmups are discarded. No failed process was used as a sample and no completed sample was omitted. Phase R precedes Phase P on the same hosted machine. Filesystem caches are not evicted.

The unchanged generic fixture has 60,701 modules. Each process verifies 60,701 no-op callback loader calls, 6,000 Acorn/escodegen calls and 3,000 regex-rewrite calls. It includes 600 builtin SWC TypeScript modules. Acorn is 8.15.0 and escodegen is 2.1.0. Cache, source maps, minification and concatenation are disabled.

Every process passed loaded-native-path and SHA-256 identity, loader-count and output-parity gates. Both phases emitted bundle.cjs SHA-256 `07642bee7459d5745ba5bb7744f02bc0ef0c41ba3ff88ab866b52d676046cca3`, identical to the earlier run.

Peak is Node's OS high-water RSS through compiler.run completion, including startup. END is before output hashing or close. Post-GC follows compiler.close, one explicit GC and the unchanged 200 ms delay, while compiler and stats are retained. Native estimate is RSS minus V8 total_physical_size, not a live allocation count. Build wall covers compiler.run only.

The paired median is the median of ten PR-minus-base differences. HL is the median of the 55 Walsh averages. The exact 95% interval inverts the same two-sided Wilcoxon signed-rank test over every sign assignment, with doubled midranks for ties and zeros excluded. The confidence-set hull is conservatively closed at Walsh breakpoints. The method assumes independent symmetric differences. Intervals are marginal without multiplicity adjustment. Percentages compare arm medians.

Hosted recomputation reran the preserved summary code on every raw receipt in both phases and required exact parsed-JSON and Markdown equality. The fixture and exact-inference code are byte-identical to the previous run. The summary code differs only in its pinned PR SHA. Process instrumentation differs only in its purge-delay receipt and assertion, with snapshot timing unchanged. The scheduler differs only in phase isolation, environment checks and child override, and deadline. GC aggregates and RSS aliases were also checked. This is automated inline verification, not an independent review. No subagents were used.

## Proposed PR-body memory line

'''
if not replicates:
    p_clause = 'the purge-delay-zero phase also detected no peak or post-GC RSS increase' if not p_increase else 'the purge-delay-zero phase still detected a peak or post-GC RSS increase'
    proposal = f'The earlier macOS arm64 RSS increase was not reproduced with defaults in a hosted follow-up, and {p_clause}; the earlier Linux x64 and Windows x64 runs detected no memory increase.'
elif not p_increase:
    proposal = 'The earlier macOS arm64 RSS increase reproduced with defaults but was not detected with MIMALLOC_PURGE_DELAY=0, consistent with delayed purging; the earlier Linux x64 and Windows x64 runs detected no memory increase.'
else:
    proposal = 'The earlier macOS arm64 RSS increase reproduced and persisted with MIMALLOC_PURGE_DELAY=0; the earlier Linux x64 and Windows x64 runs detected no memory increase.'
text += f'> {proposal}\n\nProposal only. No PR or PR body was changed.\n\n'
text += '''## Limits

One hosted runner, a generic synthetic fixture, uncontrolled ambient load and finite snapshots limit generalization. The matched ci-profile builds do not establish production-release memory behavior. The phases run in fixed order rather than randomized interleaving, so absolute cross-phase levels are descriptive. The pre-registered inference compares arms within each phase. A null interval result is not evidence of equality. The purge-delay receipt verifies the requested environment, not the allocator's internal effective settings or live allocations. The interpretation follows the pre-registered rule and is not direct allocator telemetry. Earlier data are not pooled with this run.

All builds, measurements, statistical calculations and report assembly ran on the hosted macOS job. The controlling Mac used git, gh and file edits only. No private fixture or data was used. One measurement dispatch was used; any infrastructure retry must be disclosed separately in the final publication checks. Workflow completion and artifact publication are checked after this report-generation step.

## Workflow diff versus the previous measurement run

The workflow keeps the registered filename bench-loader-result-readback.yml. It changes the name, concurrency and artifact labels, restricts the matrix to macos-15, pins the new PR head, records inherited mimalloc variables, adds Phase R and Phase P, and adds same-job hosted recomputation and report assembly. Build commands and settings, exact-source gates and per-process identity and output gates are retained. The measurement deadline is now 2026-10-19T00:40:00Z; the job timeout remains 135 minutes.

```diff
'''
text += git('diff', previous, os.environ['GITHUB_SHA'], '--', '.github/workflows/bench-loader-result-readback.yml')
text += '```\n\nHosted report assembled at ' + datetime.datetime.now(datetime.timezone.utc).isoformat() + '.\n'
(root / 'followup-report.md').write_text(text)
print('FOLLOWUP_VERIFIED phases=2 process_receipts=44 measured_processes=40 native_identity=all parity=all purge_delay=all exact_recomputation=equal')
print(f'REGISTERED_CASE replicates={replicates} purge_phase_increase={p_increase} verdict={verdict}')
print('REPORT_WRITTEN bench-data/results/followup-report.md')
