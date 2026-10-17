import datetime
import json
import math
import os
import pathlib
import re
import subprocess
import sys

root = pathlib.Path('bench-data/readout').resolve()
run = json.loads((root / 'run.json').read_text())
jobs = json.loads((root / 'jobs.json').read_text())['jobs']
artifacts = json.loads((root / 'artifacts.json').read_text())['artifacts']
assert run['status'] == 'completed' and run['conclusion'] == 'success'
assert run['head_sha'] == 'c7360f2248a88d2cc4b463b304ab94b7abf50ba5'
assert len(jobs) == 2 and all(job['conclusion'] == 'success' for job in jobs)
base = '96dcd72db4d25a89c37d22d514285ab82fc46a3d'
pr = '300a8a6a38d1251db2e75d5933676e123eddbdd0'
expected_diff = subprocess.check_output(['git', 'diff', base, pr], text=True).replace('\r\n', '\n')
platforms = {}
for platform in ['macos-15', 'windows-2025']:
    artifact_root = root / platform
    results = artifact_root / 'bench-data/results'
    script_root = artifact_root / 'scripts'
    saved = json.loads((results / 'summary.json').read_text())
    saved_text = (results / 'summary.md').read_text()
    for script in saved['environment']['fixtureScripts']:
        downloaded = (artifact_root / script).read_text().replace('\r\n', '\n')
        current = pathlib.Path(script).read_text().replace('\r\n', '\n')
        assert downloaded == current, f'Harness source mismatch: {platform}/{script}'
    assert (results / 'source.diff').read_text().replace('\r\n', '\n') == expected_diff
    for arm in ['base', 'pr']:
        log = (results / f'{arm}-build.log').read_text()
        assert 'Compiling rspack_binding_api' in log
        assert re.search(r'Finished [`\']?ci[`\']? profile.*optimized', log), f'Wrong build profile: {platform}/{arm}'
    subprocess.run([sys.executable, str(script_root / 'loader-result-readback/summary.py'), str(results)], check=True)
    recomputed = json.loads((results / 'summary.json').read_text())
    assert recomputed == saved, f'Raw-data recomputation mismatch: {platform}'
    assert (results / 'summary.md').read_text() == saved_text
    schedule = json.loads((results / 'schedule.json').read_text())
    for item in schedule:
        record = json.loads((results / item['file']).read_text())
        gc = record['gcActivity']
        assert sum(value['count'] for value in gc['byKind'].values()) == gc['count']
        assert math.isclose(sum(value['durationMs'] for value in gc['byKind'].values()), gc['durationMs'], rel_tol=1e-12, abs_tol=1e-9)
        assert record['steadyRss'] == record['snapshots']['end']['process']['rss']
        assert record['closeRss'] == record['snapshots']['close']['process']['rss']
        assert record['idleRss'] == record['snapshots']['postGc']['process']['rss']
    artifact = next(value for value in artifacts if value['name'] == f'loader-result-readback-newhead-{platform}')
    job = next(value for value in jobs if platform in value['name'])
    platforms[platform] = dict(summary=saved, table=saved_text[saved_text.index('| Metric (unit)'):], artifact=artifact, job=job, results=results)
assert platforms['macos-15']['summary']['parity']['files'] == platforms['windows-2025']['summary']['parity']['files']
assert platforms['macos-15']['summary']['parity']['files'] == [{'name': 'bundle.cjs', 'sha256': '07642bee7459d5745ba5bb7744f02bc0ef0c41ba3ff88ab866b52d676046cca3'}]
mac = platforms['macos-15']['summary']
windows = platforms['windows-2025']['summary']

def metric(summary, key):
    return next(row for row in summary['rows'] if row['metric'] == key)

def detected(summary):
    return '; '.join(row['label'] for row in summary['rows'] if row['unit'] == 'MiB' and row['increased']) or 'none'

def row_line(row):
    scale = 1024 * 1024
    low, high = row['exact95']
    return f"{row['baseMedian']/scale:.3f} → {row['prMedian']/scale:.3f} MiB ({row['percent']:+.2f}%); block-median delta {row['pairedMedian']/scale:+.3f} MiB, HL {row['hodgesLehmann']/scale:+.3f} MiB, exact interval [{low/scale:+.3f}, {high/scale:+.3f}] MiB"

used = metric(windows, 'snapshots.postGc.v8.used_heap_size')
native = metric(windows, 'snapshots.postGc.nativeEstimate')
close = metric(windows, 'snapshots.close.process.rss')
rule_pass = not used['increased'] and not native['increased']
mac_verdict = 'at least one memory snapshot component is INCREASED' if mac['memoryIncreaseDetected'] else 'no memory increase detected in any measured snapshot or component'
win_verdict = 'at least one memory snapshot component is INCREASED' if windows['memoryIncreaseDetected'] else 'no memory increase detected in any measured snapshot or component'
text = f'''# Loader result readback: new-head cross-platform memory

## Verdict

**macOS arm64: {mac_verdict}. Windows x64: {win_verdict}.**

**Windows classification: {windows['windowsClassification']}.** The decision is based only on the two pre-registered post-GC intervals, not the A/A maximum, RSS alone, GC-count significance or the timing result.

- macOS INCREASED metrics: {detected(mac)}.
- Windows INCREASED metrics: {detected(windows)}.
- Windows post-close, pre-GC working set: {row_line(close)}; {'INCREASED' if close['increased'] else 'no increase detected'}.
- Required post-GC V8 used_heap_size: {row_line(used)}; {'INCREASED' if used['increased'] else 'no increase detected'}.
- Required post-GC native estimate: {row_line(native)}; {'INCREASED' if native['increased'] else 'no increase detected'}.

This operational classification is not proof of a causal GC mechanism, a leak, or absence of retained memory. “No increase detected” is not equivalence. If either required interval is positive, the rule calls the effect unexplained, not proven retained native allocation. The pre-fix head’s historical result is background, not pooled into this experiment.

## Identity, runs and retention

Measured fork PR [#44](https://github.com/guru-irl/rspack/pull/44) at `{pr}`, against main merge base `{base}`. The measured workflow is pinned to benchmark commit `{run['head_sha']}` on `bench/loader-result-readback-xplat-300a8a6a`.

Measurement run: [{run['id']}]({run['html_url']}). Both jobs completed successfully. No failed preparation, failed process, incomplete block, omitted completed sample or result-chasing rerun occurred in this new-head experiment. The earlier pre-fix experiment’s Windows formatting failure is not a new-head attempt or a sample here. The Windows workspace formatting preflight was skipped as specified; macOS retained it.

| Platform | Job | Raw artifact ID | Fresh processes | Measured data |
| --- | --- | --- | ---: | --- |
'''
for platform, label in [('macos-15', 'macOS arm64'), ('windows-2025', 'Windows x64')]:
    data = platforms[platform]
    count = data['summary']['parity']['runs']
    text += f"| {label} | [{data['job']['id']}]({data['job']['html_url']}) | [{data['artifact']['id']}]({run['html_url']}/artifacts/{data['artifact']['id']}) | {count} | {'2 warmups discarded, 10 four-process blocks' if platform == 'windows-2025' else '2 warmups discarded, 10 alternating pairs'} |\n"
text += '\nVerified built and loaded native SHA-256s:\n\n| Platform | Base | PR |\n| --- | --- | --- |\n'
for platform, label in [('macos-15', 'macOS arm64'), ('windows-2025', 'Windows x64')]:
    hashes = platforms[platform]['summary']['parity']['bindings']
    text += f"| {label} | `{hashes['base']}` | `{hashes['pr']}` |\n"
text += '''
## Fixture and method

Reused the generic 60,701-module JS-loader fixture and existing preparation, process, pairing and exact-inference harness. Every build checks 60,701 no-op callback loader calls, 6,000 Acorn/escodegen calls and 3,000 regex-rewrite calls, with 600 builtin SWC TypeScript modules. Cache, source maps, minification and concatenation are disabled. Parser versions remain Acorn 8.15.0 and escodegen 2.1.0. No proprietary data or fixture is used.

Each OS built both exact source arms on one GitHub-hosted runner with the same repository-pinned Rust toolchain and `pnpm run build:binding:ci`: optimized ci profile, opt-level 2, no LTO/debug information, 256 codegen units, features plugin/test-loader/perfetto, CARGO_INCREMENTAL=0 and CARGO_BUILD_JOBS=3. JavaScript artifacts were built once and shared. Source comparisons against each exact arm, explicit rspack_binding_api recompilation in both build logs, profile completion, unequal native hashes, and each child’s single loaded require-cache path plus hash all passed. The candidate’s generated binding declaration was checked against its own head, which adds derived N-API interfaces; it was not incorrectly required to match the base declaration.

The Windows schedule has ten fixed four-process blocks. Orders rotate through base1/base2/pr1/pr2; pr2/pr1/base2/base1; base2/pr2/pr1/base1; pr1/base1/base2/pr2. Treatment inference uses ten contrasts, each mean(PR1, PR2) minus mean(base1, base2). Same-build A/A is family2 minus family1, regardless of execution order. macOS has ten alternating pairs, base first on odd pairs, PR first on even pairs. Both start with two discarded process warmups, base then PR. All processes are fresh, on the same fixture path per OS; filesystem cache is not evicted. No other task workload was launched on these runners.

Peak remains the original OS high-water RSS/working-set metric through build end, including process startup. **As explicitly approved, there is no sampled-peak snapshot and no V8/process companion fields are attributed to the historical peak.** All new V8 and process fields are recorded only at END, post-close and post-GC; no periodic sampler adds build overhead.

END is immediately after compiler.run, before output hashing or compiler close. Post-close follows output hashing and successful compiler.close, before explicit GC. Post-GC follows one explicit GC and 200 ms settling, with compiler and stats still retained. These are finite process snapshots, not long-run retained-memory tests. V8 fields and process fields are adjacent API reads, not an atomic combined snapshot. Native estimate means process RSS (Windows working set) minus V8 total_physical_size; it includes non-V8 residency and accounting effects, not just live native allocations. Post-close includes output-hashing allocations.

A PerformanceObserver starts before compiler.run. GC records are drained after END and restricted to entries starting within the compiler.run window, excluding setup, output hashing, close and explicit post-close GC. Counts and total duration are recorded overall and by numeric Node GC kind: 1 minor, 4 major, 8 incremental, 16 weak callbacks. Missing kinds have zero count/time. Wall is compiler.run only and is secondary.

Percent changes use arm medians over all measured processes, not ratios of block contrasts. Paired/block delta is the median of ten paired or block differences; HL is the median of their 55 Walsh averages. Exact 95% intervals invert the two-sided Wilcoxon signed-rank test over all sign assignments, using doubled midranks for ties, excluding zeros, and conservatively closing the confidence-set hull at Walsh breakpoints. Independent, symmetric paired/block differences are assumed. Intervals are marginal, not multiplicity-adjusted; the expanded diagnostic metrics increase the chance of isolated detections. INCREASED means the lower endpoint is strictly above zero. A/A spreads are descriptive, not a significance gate. Percent change is n/a when the base median is zero.

**Fixed Windows rule:** classify the post-close rise as GC timing only when BOTH post-GC V8 used_heap_size and post-GC native estimate show no detected increase. Fewer GCs or lower GC time are supporting evidence only. No extra criterion or rerun was introduced after seeing results.

## Hosted environments

| Platform | Node | OS / release | CPU / logical CPUs | RAM | Runner image | Evidence window (UTC) |
| --- | --- | --- | --- | --- | --- | --- |
'''
for platform, label in [('macos-15', 'macOS arm64'), ('windows-2025', 'Windows x64')]:
    data = platforms[platform]
    env = data['summary']['environment']
    finished = (data['results'] / 'finished.txt').read_text().strip()
    text += f"| {label} | {env['node']} | {env['os']} / {env['release']} | {env['cpus'][0]['model']} / {len(env['cpus'])} | {env['ram']/1024**3:.2f} GiB | {env['image']} / {env['imageVersion']} | {env['started']} to {finished} |\n"
for platform, label in [('macos-15', 'macOS arm64'), ('windows-2025', 'Windows x64')]:
    text += f"\n## {label}: every snapshot, component and GC metric\n\nMemory is MiB; GC time is ms; build wall is seconds.\n\n{platforms[platform]['table']}\n"
text += '\n## Windows GC support and limits\n\n'
for key in ['gcActivity.count', 'gcActivity.durationMs']:
    row = metric(windows, key)
    low, high = row['exact95']
    text += f"- {row['label']}: base median {row['baseMedian']:.3f}, PR median {row['prMedian']:.3f}; block-median delta {row['pairedMedian']:+.3f}, HL {row['hodgesLehmann']:+.3f}, exact interval [{low:+.3f}, {high:+.3f}] {row['unit']}.\n"
text += '\nThe GC metrics do not override either required post-GC interval. One hosted machine per OS, uncontrolled ambient load, a synthetic fixture and finite one-GC snapshots limit generalization. No unmeasured platform or production-release profile is inferred from these numbers. Linux’s no-detected-increase result is supplied prior evidence, not remeasured here.\n'
if not rule_pass:
    reason = 'post-GC native-estimate memory' if native['increased'] else 'post-GC V8 used heap'
    proposal = f"Linux showed no detected memory increase; macOS {'had snapshot-component increases' if mac['memoryIncreaseDetected'] else 'showed no detected increase'}; Windows had higher {reason}, leaving the pre-GC rise unexplained."
else:
    proposal = f"Linux showed no detected memory increase; macOS {'had snapshot-component increases' if mac['memoryIncreaseDetected'] else 'showed no detected increase'}; Windows {'had snapshot-component increases but met' if windows['memoryIncreaseDetected'] else 'showed no detected increase and met'} the fixed GC-timing rule."
text += f'''\n## Proposed one-sentence memory line for #44

> {proposal}

Proposal only; PR #44 was not edited.

## Output parity and fresh verification

Every warmup and measured process passed the exact loader counts, loaded-path/hash identity and emitted-file SHA-256 parity gates. Both platforms emitted the same bundle.cjs SHA-256, also matching the earlier generic-fixture experiment:

`07642bee7459d5745ba5bb7744f02bc0ef0c41ba3ff88ab866b52d676046cca3`.

A separate hosted readout recomputed each full summary from all raw JSON process receipts using its original exact-inference script, required exact parsed-JSON and Markdown equality, checked source diffs and normalized harness-source equality, confirmed both optimized build logs and checked GC count/time aggregation and RSS aliases. All 64 process identities and parity receipts were checked; 60 processes supply inference and four are discarded warmups. No measurements were repeated for readout. This is automated inline verification, not an independent subagent review; subagents were prohibited.

Readout run: https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']} . Its artifact preserves this report, both raw platform artifacts, recomputed summaries and verification logs for 30 days. Readout assembly time: {datetime.datetime.now(datetime.timezone.utc).isoformat()}.

All build, measurement, fixture generation, artifact analysis and statistical work ran on GitHub-hosted runners. Mac activity was limited to git/gh and small text operations in the explicitly isolated branch/worktree. Pushes used explicit commit SHAs and remote-tip verification; no force push, PR edit, comment, subagent or other worker branch was used. Final local publication and owned-run cleanup checks are recorded below after readout completion.
'''
pathlib.Path('bench-data/final-report.md').write_text(text)
print('READOUT_VERIFIED summaries=2 process_receipts=64 measured_processes=60 native_identity=all parity=all exact_recomputation=equal')
print('REPORT_WRITTEN bench-data/final-report.md')
