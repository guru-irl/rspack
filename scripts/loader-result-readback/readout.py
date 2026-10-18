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
measurement_sha = '9029daa62b7baaf7b10e903e84d78f7aecb0dec9'
harness_sha = 'ddf722c145248fdb933139f224b6cef7ddb5c1dd'
base = 'd9d09d4152cd15fc46eb5d1cb8d9b227bfcd39eb'
pr = 'aad661921bdd07380ad7cb9f2bf3debef2f210d7'
assert run['status'] == 'completed' and run['conclusion'] == 'success'
assert run['head_sha'] == measurement_sha
assert run['head_branch'] == 'bench/single-wake-xplat-aad66192'
assert len(jobs) == 3 and all(job['conclusion'] == 'success' for job in jobs)
expected_files = ['crates/rspack_binding_api/src/plugins/js_loader/mod.rs', 'crates/rspack_binding_api/src/plugins/js_loader/scheduler.rs', 'crates/rspack_napi/src/threadsafe_function.rs']
assert subprocess.check_output(['git', 'diff', '--name-only', base, pr], text=True).splitlines() == expected_files
expected_diff = subprocess.check_output(['git', 'diff', base, pr], text=True).replace('\r\n', '\n')
for script in ['scripts/program-native/prepare.mjs', 'scripts/program-native/run.mjs', 'scripts/loader-result-readback/exact.py']:
    assert subprocess.check_output(['git', 'show', f'{harness_sha}:{script}']) == pathlib.Path(script).read_bytes(), script
old_pairs = subprocess.check_output(['git', 'show', f'{harness_sha}:scripts/loader-result-readback/pairs.mjs'], text=True)
assert old_pairs.replace('2026-10-17T19:20:00Z', '2026-10-19T00:35:00Z') == pathlib.Path('scripts/loader-result-readback/pairs.mjs').read_text()
platform_order = [('ubuntu-24.04', 'Linux x64'), ('macos-15', 'macOS arm64'), ('windows-2025', 'Windows x64')]
platforms = {}
receipt_count = 0
measured_count = 0
for platform, label in platform_order:
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
    assert (results / 'actual-source-files.txt').read_text().splitlines() == expected_files
    assert (results / 'expected-source-files.txt').read_text().splitlines() == expected_files
    build_times = {}
    for arm in ['base', 'pr']:
        log = (results / f'{arm}-build.log').read_text()
        assert 'Compiling rspack_binding_api' in log and 'Compiling rspack_napi' in log
        matched = re.search(r'Finished [`\']?ci[`\']? profile.*optimized.* in (.+)', log)
        assert matched, f'Wrong build profile: {platform}/{arm}'
        build_times[arm] = matched.group(1).strip()
    subprocess.run([sys.executable, str(script_root / 'loader-result-readback/summary.py'), str(results)], check=True)
    assert json.loads((results / 'summary.json').read_text()) == saved, f'Raw-data recomputation mismatch: {platform}'
    assert (results / 'summary.md').read_text() == saved_text
    schedule = json.loads((results / 'schedule.json').read_text())
    receipt_count += len(schedule)
    measured_count += saved['samples']
    for item in schedule:
        record = json.loads((results / item['file']).read_text())
        gc = record['gcActivity']
        assert sum(value['count'] for value in gc['byKind'].values()) == gc['count']
        assert math.isclose(sum(value['durationMs'] for value in gc['byKind'].values()), gc['durationMs'], rel_tol=1e-12, abs_tol=1e-9)
        assert record['steadyRss'] == record['snapshots']['end']['process']['rss']
        assert record['closeRss'] == record['snapshots']['close']['process']['rss']
        assert record['idleRss'] == record['snapshots']['postGc']['process']['rss']
        if platform == 'ubuntu-24.04':
            assert record['bindingIdentity']['verifiedInMaps'] and record['mainCpuMs'] is not None
    artifact = next(value for value in artifacts if value['name'] == f'single-wake-memory-{platform}')
    job = next(value for value in jobs if platform in value['name'])
    platforms[platform] = dict(summary=saved, table=saved_text[saved_text.index('| Metric (unit)'):], artifact=artifact, job=job, results=results, build_times=build_times)
assert receipt_count == 86 and measured_count == 80
parity = platforms['ubuntu-24.04']['summary']['parity']['files']
assert all(data['summary']['parity']['files'] == parity for data in platforms.values())
assert parity == [{'name': 'bundle.cjs', 'sha256': '07642bee7459d5745ba5bb7744f02bc0ef0c41ba3ff88ab866b52d676046cca3'}]

def metric(summary, key):
    return next(row for row in summary['rows'] if row['metric'] == key)

def row_line(row):
    unit = row['unit']
    scale = 1024 * 1024 if unit == 'MiB' else 1000 if unit == 's' else 1
    low, high = row['exact95']
    percent = f"{row['percent']:+.4f}%" if row['percent'] is not None else 'n/a'
    return f"{row['baseMedian']/scale:.6f} to {row['prMedian']/scale:.6f} {unit}, {percent}; paired/block median delta {row['pairedMedian']/scale:+.6f}, HL {row['hodgesLehmann']/scale:+.6f}, exact interval [{low/scale:+.6f}, {high/scale:+.6f}] {unit}"

text = '# Single-wake cross-platform memory\n\n## Verdict\n\n'
for platform, label in platform_order:
    summary = platforms[platform]['summary']
    increased = [row for row in summary['rows'] if row['unit'] == 'MiB' and row['increased']]
    text += f"**{label}: {'INCREASED in at least one measured memory metric' if increased else 'no memory increase detected in any measured snapshot or component'}.**\n\n"
    if increased:
        for row in increased:
            text += f"- INCREASED, {row['label']}: {row_line(row)}.\n"
        text += '\n'
    else:
        text += '- INCREASED memory metrics: none.\n\n'
text += 'INCREASED means the exact interval lower bound is strictly above zero. No increase detected is not proof of equality or memory neutrality. These are marginal intervals without multiplicity adjustment. Every detected component is listed, even when the primary metrics show no detected increase.\n\n'
text += '### Primary peak and steady metrics\n\n| Platform | Metric | Base median MiB | PR median MiB | Change | Paired/block median delta MiB | HL MiB | Exact 95% interval MiB | Verdict |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |\n'
for platform, label in platform_order:
    for key, name in [('peakRss', 'Peak'), ('snapshots.postGc.process.rss', 'Steady, post-GC')]:
        row = metric(platforms[platform]['summary'], key)
        lo, hi = row['exact95']
        scale = 1024 * 1024
        text += f"| {label} | {name} | {row['baseMedian']/scale:.3f} | {row['prMedian']/scale:.3f} | {row['percent']:+.2f}% | {row['pairedMedian']/scale:+.3f} | {row['hodgesLehmann']/scale:+.3f} | [{lo/scale:+.3f}, {hi/scale:+.3f}] | {'INCREASED' if row['increased'] else 'No increase detected'} |\n"
text += f'''\n## Arms, run and native identity

Base `{base}` versus fork branch `perf-js-call-single-wake` at `{pr}`. The exact-source gate checked that the PR changes exactly the three requested Rust files, that its remote branch equals the pinned PR SHA, and that each selected source tree equals its exact arm outside the workflow and retained harness directories. Both changed Rust crates recompiled in both arms on every OS. Generated binding declarations also match the exact PR arm.

Measurement run [{run['id']}]({run['html_url']}) used benchmark commit `{measurement_sha}` on `bench/single-wake-xplat-aad66192`. All three jobs succeeded. There was one measurement run, no failed measurement attempt, no failed process, no omitted completed sample and no result-chasing rerun. Windows skipped only the inherited workspace formatting preflight. Linux and macOS retained it.

| Platform | Job | Raw artifact ID | Fresh processes | Protocol |
| --- | --- | --- | ---: | --- |
'''
for platform, label in platform_order:
    data = platforms[platform]
    protocol = '2 discarded warmups, 10 four-process blocks' if platform == 'windows-2025' else '2 discarded warmups, 10 alternating pairs'
    text += f"| {label} | [{data['job']['id']}]({data['job']['html_url']}) | [{data['artifact']['id']}]({run['html_url']}/artifacts/{data['artifact']['id']}) | {data['summary']['parity']['runs']} | {protocol} |\n"
text += '\n| Platform | Base native SHA-256 | PR native SHA-256 |\n| --- | --- | --- |\n'
for platform, label in platform_order:
    hashes = platforms[platform]['summary']['parity']['bindings']
    text += f"| {label} | `{hashes['base']}` | `{hashes['pr']}` |\n"
text += '''
## Fixture and method

The #44 harness at `ddf722c145248fdb933139f224b6cef7ddb5c1dd` is reused. Preparation, process instrumentation and exact inference are byte-identical. The process schedule changed only its expired deadline to 2026-10-19T00:35:00Z. Linux uses the same non-Windows paired schedule. The full workflow diff is below.

The generic fixture has 60,701 modules. Every process checks 60,701 no-op callback loader calls, 6,000 Acorn/escodegen calls and 3,000 regex-rewrite calls, with 600 builtin SWC TypeScript modules. Acorn is 8.15.0 and escodegen is 2.1.0. Cache, source maps, minification and concatenation remain disabled. No proprietary fixture is used.

Both exact arms build on the same hosted runner per OS with `pnpm run build:binding:ci`, the optimized ci profile, opt-level 2, no LTO or debug information, 256 codegen units, features plugin/test-loader/perfetto, CARGO_INCREMENTAL=0 and CARGO_BUILD_JOBS=3. JavaScript artifacts build once and are shared within each OS. Each arm uses the base's dependency manifests and lockfiles. The only source differences between arms are the three PR files.

Windows uses ten fixed four-process blocks. Orders rotate through base1/base2/pr1/pr2; pr2/pr1/base2/base1; base2/pr2/pr1/base1; pr1/base1/base2/pr2. Each treatment contrast is mean(PR1, PR2) minus mean(base1, base2). Same-build deltas are family2 minus family1, regardless of execution order. Linux and macOS use ten alternating pairs, base first on odd pairs and PR first on even pairs. Each OS begins with two discarded warmups, base then PR. All processes are fresh. Filesystem caches are not evicted. No other task workload was launched on the runners.

Peak is the inherited OS high-water value through build end, including process startup, from `process.resourceUsage().maxRSS * 1024`. On Linux this is getrusage ru_maxrss in KiB, an OS high-water RSS equivalent to the requested VmHWM measurement. macOS reports high-water RSS and Windows reports peak working set through Node's API. There is no periodic sampler, peak-time V8 snapshot or companion component attributed to the historical peak.

END follows compiler.run, before output hashing or close. Post-close follows output hashing and successful compiler.close, before explicit GC. Post-GC follows one explicit GC and 200 ms settling, with compiler and stats still retained. Each records the five V8 fields, all process.memoryUsage fields and native estimate, RSS or working set minus V8 total_physical_size. This estimate includes residency and accounting effects, not only live native allocations. Adjacent V8 and process reads are not an atomic snapshot. Post-close includes output-hashing allocations.

The GC observer starts before compiler.run. Records are drained after END and restricted to entries starting during compiler.run. Counts and durations exclude setup, output hashing, close and explicit post-close GC. Node GC kinds are 1 minor, 4 major, 8 incremental and 16 weak callbacks. Missing kinds are zero. Build wall covers compiler.run only and is informational.

Percent changes use arm medians across measured processes. Paired/block delta is the median of ten differences. Hodges-Lehmann, HL, is the median of the 55 Walsh averages. Exact 95% intervals invert the two-sided Wilcoxon signed-rank test over all sign assignments, with doubled midranks for ties and zeros excluded. The confidence-set hull is conservatively closed at Walsh breakpoints. Independent symmetric differences are assumed. Intervals are marginal, not multiplicity-adjusted. Windows same-build spreads are descriptive, not a gate.

The inherited Windows diagnostic rule is unchanged. A post-close rise counts as GC timing only if neither post-GC V8 used_heap_size nor the post-GC native estimate has a positive lower interval bound. Fewer GCs or less GC time are supporting evidence only. This rule does not override an INCREASED verdict for any component and does not establish a causal GC mechanism.

## Hosted environments and build time

| Platform | Node | OS / release | CPU / logical CPUs | RAM | Runner image | Evidence window UTC |
| --- | --- | --- | --- | --- | --- | --- |
'''
for platform, label in platform_order:
    data = platforms[platform]
    env = data['summary']['environment']
    finished = (data['results'] / 'finished.txt').read_text().strip()
    text += f"| {label} | {env['node']} | {env['os']} / {env['release']} | {env['cpus'][0]['model']} / {len(env['cpus'])} | {env['ram']/1024**3:.2f} GiB | {env['image']} / {env['imageVersion']} | {env['started']} to {finished} |\n"
text += '\nNative build command elapsed time, as reported by Cargo, is informational.\n\n| Platform | Base native build | PR native build |\n| --- | --- | --- |\n'
for platform, label in platform_order:
    times = platforms[platform]['build_times']
    text += f"| {label} | {times['base']} | {times['pr']} |\n"
for platform, label in platform_order:
    text += f"\n## {label}: all snapshots, components and GC metrics\n\nMemory is MiB, GC time is ms, and compiler.run wall is seconds.\n\n{platforms[platform]['table']}\n"
windows = platforms['windows-2025']['summary']
text += f"\n## Windows diagnostic rule\n\nClassification: {windows['windowsClassification']}.\n\n"
for key in ['snapshots.close.process.rss', 'snapshots.postGc.v8.used_heap_size', 'snapshots.postGc.nativeEstimate', 'gcActivity.count', 'gcActivity.durationMs']:
    row = metric(windows, key)
    text += f"- {row['label']}: {row_line(row)}; {'INCREASED' if row['increased'] else 'no increase detected'}.\n"
any_increase = any(data['summary']['memoryIncreaseDetected'] for data in platforms.values())
proposal = 'No memory increase was detected in the measured peak, END, post-close or post-GC snapshots on Linux x64, macOS arm64 or Windows x64.'
if any_increase:
    detected_labels = [label for platform, label in platform_order if platforms[platform]['summary']['memoryIncreaseDetected']]
    proposal = 'Memory snapshot components increased on ' + ', '.join(detected_labels) + ', so cross-platform memory neutrality is not established.'
text += f'''\n## Proposed one-sentence memory line

> {proposal}

Proposal only. No PR was opened or edited.

## Output parity, verification and limits

All 86 processes passed distinct-arm native identity, loaded path and hash, loader-count and emitted-output parity gates. Linux also verified the mapped binding path in every process. The 80 measured processes supply inference; six warmups are discarded. Every OS emitted the same bundle.cjs SHA-256:

`{parity[0]['sha256']}`.

This separate hosted readout recomputed every summary from the original raw receipts using the preserved exact-inference script and required exact parsed-JSON and Markdown equality. It verified source diffs and their exact three-file lists, normalized harness-source equality, both optimized build logs, recompilation of both changed Rust crates, unchanged fixture and process instrumentation, deadline-only schedule edits, GC count/time aggregation and RSS aliases. Measurements were not repeated. This is automated inline verification, not an independent review. Subagents were prohibited.

Readout run: https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}. Its artifact `single-wake-memory-verified` preserves this report, all three raw artifacts, recomputed summaries and verification logs for 30 days. Readout assembly time: {datetime.datetime.now(datetime.timezone.utc).isoformat()}.

One hosted machine per OS, uncontrolled ambient load, a synthetic fixture and finite one-GC snapshots limit generalization. These matched ci-profile builds do not establish production-release memory behavior. No increase detected does not prove the no-increase requirement. The promise-returning loader runner is exercised by this fixture, but no separate promise-hook stress fixture was added.

All builds, fixture generation, measurements, statistical analysis and readout ran on GitHub-hosted runners. The controlling machine used only git, gh and small file edits. Pushes used explicit commit SHAs with remote-tip verification, never force. No PR, comment, subagent, other worker branch or volatile scratch directory was used.

## Workflow diff versus the #44 harness

The registered measurement filename remains `.github/workflows/bench-loader-result-readback.yml`. Changes are the experiment name, concurrency and artifact labels, arm SHAs, Linux matrix mappings and clock ticks, complete base source selection before dependency install, exact three-file/branch checks and recompilation checks for the second changed Rust crate. Build commands, profile, warmups, orders, process instrumentation and inference are unchanged. The hosted readout is retargeted to this measurement run and the three new artifact labels.

```diff
'''
text += subprocess.check_output(['git', 'diff', harness_sha, measurement_sha, '--', '.github/workflows/bench-loader-result-readback.yml'], text=True)
text += '```\n\nFinal local publication and owned-run cleanup checks follow after readout completion.\n'
pathlib.Path('bench-data/final-report.md').write_text(text)
print(f'READOUT_VERIFIED summaries=3 process_receipts={receipt_count} measured_processes={measured_count} native_identity=all parity=all exact_recomputation=equal')
print('REPORT_WRITTEN bench-data/final-report.md')
