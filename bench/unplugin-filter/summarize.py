import json
import pathlib
import statistics as st
from paired_stats import paired

root = pathlib.Path('results')
rows = [json.loads(line) for line in (root / 'samples.jsonl').read_text().splitlines()]
host = json.loads((root / 'host.json').read_text())
MIB = 1024 ** 2
arms = ['U0', 'U2r2', 'RX']
fields = {
    'wall_s': lambda r: r['wall_ms'] / 1000,
    'cpu_s': lambda r: r['cpu_ms'] / 1000,
    'make_s': lambda r: r['phase_split']['make_ms'] / 1000,
    'peak_anon_mib': lambda r: r['peak_anon_mib'],
    'end_anon_mib': lambda r: r['end_anon_mib'],
    'heap_used_mib': lambda r: r['heap']['used_heap_size'] / MIB,
    'heap_physical_mib': lambda r: r['heap']['total_physical_size'] / MIB,
    'minor_gc': lambda r: r['gc'].get('1', {}).get('count', 0),
    'major_gc': lambda r: r['gc'].get('4', {}).get('count', 0),
}
summary = {'host': host, 'medians': {}, 'pairs': {}, 'gc_controls': {}, 'parity': json.loads((root / 'parity.json').read_text()), 'resolve_counts': json.loads((root / 'resolve-counts.json').read_text())}
lines = ['# Round 2 speed and parity', '', f"Run: {host['run_url']}; commit `{host['commit']}`", '', '| Condition | Stock s | Patched s | RegExp s | Patched-stock s (%) | Exact p | Signs (-/0/+) | Patched-RegExp s (%) | Exact p |', '|---|---:|---:|---:|---:|---:|---|---:|---:|']
for variant in ['broad', 'narrow']:
    for phase in ['cold', 'warm']:
        key = f'{variant}/{phase}'
        groups = {arm: sorted([r for r in rows if (r['series'], r['variant'], r['phase'], r['arm']) == ('default', variant, phase, arm)], key=lambda r: r['tag']) for arm in arms}
        assert all(len(group) == 5 for group in groups.values())
        assert all([r['tag'] for r in group] == [r['tag'] for r in groups['U0']] for group in groups.values())
        summary['medians'][key] = {arm: {name: st.median(fn(r) for r in group) for name, fn in fields.items()} for arm, group in groups.items()}
        summary['pairs'][key] = {}
        for left, right in [('U0', 'U2r2'), ('RX', 'U2r2'), ('U0', 'RX')]:
            comparison = {name: paired([fn(r) for r in groups[left]], [fn(r) for r in groups[right]]) for name, fn in fields.items()}
            comparison['wall_pct'] = st.median((b['wall_ms'] / a['wall_ms'] - 1) * 100 for a, b in zip(groups[left], groups[right]))
            comparison['peak_pct'] = st.median((b['peak_anon_mib'] / a['peak_anon_mib'] - 1) * 100 for a, b in zip(groups[left], groups[right]))
            summary['pairs'][key][f'{right}-{left}'] = comparison
        a, b = summary['pairs'][key]['U2r2-U0'], summary['pairs'][key]['U2r2-RX']
        m = summary['medians'][key]
        lines.append(f"| {key} | {m['U0']['wall_s']:.3f} | {m['U2r2']['wall_s']:.3f} | {m['RX']['wall_s']:.3f} | {a['wall_s']['median']:+.3f} ({a['wall_pct']:+.2f}%) | {a['wall_s']['p']:.4f} | {a['wall_s']['negative']}/{a['wall_s']['zero']}/{a['wall_s']['positive']} | {b['wall_s']['median']:+.3f} ({b['wall_pct']:+.2f}%) | {b['wall_s']['p']:.4f} |")
        summary['gc_controls'][key] = {}
        for arm in arms:
            controls = [r for r in rows if (r['series'], r['variant'], r['phase'], r['arm']) == ('gc-control', variant, phase, arm)]
            assert len(controls) == 1
            r = controls[0]
            summary['gc_controls'][key][arm] = {'heap_used_mib': r['post_gc']['heap']['used_heap_size'] / MIB, 'physical_mib': r['post_gc']['heap']['total_physical_size'] / MIB, 'anon_mib': r['post_gc']['anon_mib']}
lines += ['', '## Default-generation cold memory', '', '| Condition | Arm | Peak anon MiB | End anon MiB | Minor GC | Major GC | Post-GC heap used MiB (excluded n=1) |', '|---|---|---:|---:|---:|---:|---:|']
for variant in ['broad', 'narrow']:
    key = variant + '/cold'
    for arm in arms:
        m, c = summary['medians'][key][arm], summary['gc_controls'][key][arm]
        lines.append(f"| {key} | {arm} | {m['peak_anon_mib']:.3f} | {m['end_anon_mib']:.3f} | {m['minor_gc']:.0f} | {m['major_gc']:.0f} | {c['heap_used_mib']:.3f} |")
lines += ['', 'n=5 interleaved fresh-process own-cache cold/warm pairs. Default V8 flags; no forced GC in timed samples. Exact two-sided paired Wilcoxon with average tied ranks and zeros dropped. Minimum p at five nonzero pairs is 0.0625. Paired medians are not independent median differences. RssAnon includes native memory and allocator behavior. No production or cross-platform guarantee. Full raw data, host, hashes, callback counts and GC events are artifacts.', '']
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
(root / 'u2r2-runner-report.md').write_text('\n'.join(lines))
print('\n'.join(lines))
