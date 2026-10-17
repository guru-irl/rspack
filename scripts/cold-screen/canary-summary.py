import json
import os
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'loader-result-readback'))
from exact import paired_location

output = Path(sys.argv[1])
roots = [Path(arg) for arg in sys.argv[2:]]
output.mkdir(parents=True, exist_ok=True)
arms = None
metrics = {
    'post_gc_rss_mib': lambda r: r['idleRss'] / 2**20,
    'peak_rss_mib': lambda r: r['peakRss'] / 2**20,
    'build_end_rss_mib': lambda r: r['steadyRss'] / 2**20,
    'native_estimate_mib': lambda r: r['snapshots']['postGc']['nativeEstimate'] / 2**20,
    'v8_heap_used_mib': lambda r: r['snapshots']['postGc']['v8']['used_heap_size'] / 2**20,
    'v8_physical_mib': lambda r: r['snapshots']['postGc']['v8']['total_physical_size'] / 2**20,
    'wall_s': lambda r: r['buildMs'] / 1000,
    'main_cpu_s': lambda r: r['mainCpuMs'] / 1000,
    'process_cpu_s': lambda r: sum(r['processCpuUs'].values()) / 1e6,
}
footprint_mode = os.environ.get('MEASURE_PHYS_FOOTPRINT') == '1'
if footprint_mode:
    metrics.update({
        'post_gc_phys_footprint_mib': lambda r: r['snapshots']['postGc']['footprint']['physFootprint'] / 2**20,
        'build_end_phys_footprint_mib': lambda r: r['snapshots']['end']['footprint']['physFootprint'] / 2**20,
        'peak_phys_footprint_mib': lambda r: r['snapshots']['postGc']['footprint']['peakPhysFootprint'] / 2**20,
        'post_gc_reclaimable_mib': lambda r: r['snapshots']['postGc']['footprint']['reclaimableBytes'] / 2**20,
        'build_end_probe_ms': lambda r: r['snapshots']['end']['footprint']['durationMs'],
        'post_gc_probe_ms': lambda r: r['snapshots']['postGc']['footprint']['durationMs'],
    })
jobs = {}
for job_id, root in enumerate(roots, 1):
    if not (root / 'complete.json').exists():
        raise ValueError(f'Incomplete job: {root}')
    protocol = json.loads((root / 'protocol.json').read_text())
    schedule = json.loads((root / 'schedule.json').read_text())
    if protocol['phase'] not in ['CM', 'SP'] or protocol['rounds'] != 8:
        raise ValueError('Wrong protocol')
    expected_arms = ['O', 'A', 'B', 'C', 'D'] if protocol['phase'] == 'CM' else ['O', 'D']
    if arms is not None and arms != expected_arms:
        raise ValueError('Mixed protocols')
    arms = expected_arms
    measured = [item for item in schedule if item['round'] > 0]
    if len(measured) != 8 * len(arms) or len(schedule) != 9 * len(arms):
        raise ValueError('Incomplete fixed schedule')
    rows = {}
    identities = json.loads((root / 'identity-manifest.json').read_text())
    if set(identities) != set(arms) or len({v['sha256'] for v in identities.values()}) != len(arms):
        raise ValueError('IDENTITY GATE: missing or duplicate native hashes')
    if footprint_mode:
        expected = {'O': '4229de6dfa1cabdac3f264ccced223c6e2e3ea24db9a7dba715451aa5c13a73b', 'D': '7e362044e46396fbfa7dec89110c75daeba7cea62c9c4134c7278ab60a3a1957'}
        if {a: v['sha256'] for a, v in identities.items()} != expected:
            raise ValueError('IDENTITY GATE: retained native hashes differ')
        attempts = json.loads((root / 'attempts.json').read_text())
        if len(attempts) != 19 or not attempts[0]['wrongIdentity'] or attempts[0]['exitCode'] == 0:
            raise ValueError('Missing negative identity gate or unexpected attempt count')
        if any(a['exitCode'] != 0 or a.get('error') for a in attempts[1:]):
            raise ValueError('Failed command is not a sample')
        for r in range(1, 9):
            actual_order = [a['arm'] for a in schedule if a['round'] == r]
            if actual_order != (['O', 'D'] if r % 2 else ['D', 'O']):
                raise ValueError('Incorrect alternating order')
    parity = {}
    for item in schedule:
        result = json.loads((root / item['file']).read_text())
        arm = item['arm']
        if item['exitCode'] != 0 or result['errorCount'] != 0 or result['moduleCount'] != 60701:
            raise ValueError('Failed build is not a sample')
        if result['bindingSha256'] != identities[arm]['sha256'] or not result['bindingIdentity']['verifiedInRequireCache']:
            raise ValueError('IDENTITY GATE: process mismatch')
        if footprint_mode:
            for snapshot in ['end', 'postGc']:
                probe = result['snapshots'][snapshot]['footprint']
                if probe['exitCode'] != 0 or probe['pid'] != result['pid'] or probe.get('error'):
                    raise ValueError('Failed or wrong-PID footprint probe')
                if probe['tool'] != '/usr/bin/footprint' or probe['durationMs'] <= 0:
                    raise ValueError('Invalid probe metadata')
        shape = result['outputFiles']
        if arm in parity and parity[arm] != shape:
            raise ValueError('Unstable output within arm')
        parity[arm] = shape
        if item['round'] > 0:
            key = (item['round'], arm)
            if key in rows:
                raise ValueError('Duplicate pair key')
            rows[key] = result
    if set(rows) != {(r, a) for r in range(1, 9) for a in arms}:
        raise ValueError('Incomplete round pairing')
    jobs[f'job-{job_id}'] = {'rows': rows, 'identities': identities, 'environment': json.loads((root / 'environment.json').read_text()), 'parity': parity}
if len(jobs) == 2:
    first, second = jobs.values()
    for arm in arms:
        if first['identities'][arm]['sha256'] != second['identities'][arm]['sha256'] or first['parity'][arm] != second['parity'][arm]:
            raise ValueError('Cross-job arm identity or output mismatch')

summary = {'jobs': {}, 'groups': {}}
for name, job in jobs.items():
    summary['jobs'][name] = {k: v for k, v in job.items() if k != 'rows'}
groups = {name: [job] for name, job in jobs.items()}
if len(jobs) > 1:
    groups['pooled'] = list(jobs.values())
lines = ['# macOS memory screen', '', 'Positive deltas mean more memory or time in the newer arm.', '']
for group, selected in groups.items():
    cells = {}
    for arm in arms:
        data = [job['rows'][(r, arm)] for job in selected for r in range(1, 9)]
        cells[arm] = {'medians': {metric: statistics.median(get(row) for row in data) for metric, get in metrics.items()}, 'warningCounts': sorted({r['warningCount'] for r in data}), 'errorCounts': sorted({r['errorCount'] for r in data}), 'moduleCounts': sorted({r['moduleCount'] for r in data}), 'outputFiles': data[0]['outputFiles']}
    comparisons = {}
    for base, treatment in [*zip(arms, arms[1:]), *([('O', 'D')] if len(arms) > 2 else [])]:
        comparisons[f'{treatment}-{base}'] = {}
        for metric, get in metrics.items():
            b = [get(job['rows'][(r, base)]) for job in selected for r in range(1, 9)]
            t = [get(job['rows'][(r, treatment)]) for job in selected for r in range(1, 9)]
            comparisons[f'{treatment}-{base}'][metric] = {'pairs': len(b), 'baseMedian': statistics.median(b), 'treatmentMedian': statistics.median(t), 'deltas': [y - x for x, y in zip(b, t)], **paired_location(b, t)}
    summary['groups'][group] = {'cells': cells, 'comparisons': comparisons}
    lines += [f'## {group}: arm medians', '', '| Arm | Post-GC MiB | Peak MiB | End MiB | RSS minus V8 physical MiB | V8 heap used MiB | Wall s | Main CPU s | Process CPU s |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for arm, cell in cells.items():
        keys = ['post_gc_rss_mib', 'peak_rss_mib', 'build_end_rss_mib', 'native_estimate_mib', 'v8_heap_used_mib', 'wall_s', 'main_cpu_s', 'process_cpu_s']
        lines.append('| ' + arm + ' | ' + ' | '.join(f"{cell['medians'][key]:.3f}" for key in keys) + ' |')
    if footprint_mode:
        footprint_keys = ['post_gc_rss_mib', 'post_gc_phys_footprint_mib', 'build_end_rss_mib', 'build_end_phys_footprint_mib', 'peak_phys_footprint_mib', 'post_gc_reclaimable_mib', 'build_end_probe_ms', 'post_gc_probe_ms']
        lines += ['', f'## {group}: footprint medians', '', '| Arm | Post-GC RSS MiB | Post-GC footprint MiB | End RSS MiB | End footprint MiB | Peak footprint MiB | Reclaimable MiB | End probe ms | Post-GC probe ms |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
        for arm, cell in cells.items():
            lines.append('| ' + arm + ' | ' + ' | '.join(f"{cell['medians'][key]:.3f}" for key in footprint_keys) + ' |')
    lines += ['', f'## {group}: paired HL delta [exact 95%]', '', '| Step | Metric | Pairs | HL delta | Exact 95% |', '| --- | --- | ---: | ---: | --- |']
    for step, values in comparisons.items():
        for metric, value in values.items():
            low, high = value['exact95']
            lines.append(f"| {step} | {metric} | {value['pairs']} | {value['hodgesLehmann']:+.3f} | [{low:+.3f}, {high:+.3f}] |")
    lines += ['']
if 'pooled' in summary['groups'] and len(arms) > 2:
    contrasts = summary['groups']['pooled']['comparisons']
    total = contrasts['D-O']['post_gc_rss_mib']
    candidates = [step for step in ['A-O', 'B-A', 'C-B', 'D-C'] if contrasts[step]['post_gc_rss_mib']['hodgesLehmann'] >= 2 * total['hodgesLehmann'] / 3 and contrasts[step]['post_gc_rss_mib']['exact95'][0] > 0]
    summary['effectGate'] = {'positiveTotalDetected': total['exact95'][0] > 0, 'candidates': candidates, 'timingGateNotEvaluated': True}
    lines += ['## Effect gate', '', json.dumps(summary['effectGate']), '']
(output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
(output / 'summary.md').write_text('\n'.join(lines) + '\n')
print('\n'.join(lines))
