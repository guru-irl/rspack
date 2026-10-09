import json
import pathlib
import statistics as st
import sys
from paired_stats import paired

root = pathlib.Path('results')
mode = sys.argv[1]
rows = [json.loads(line) for line in (root / 'samples.jsonl').read_text().splitlines()]
assert len(rows) == 30 and all(r['series'] == mode for r in rows)
MIB = 1024 ** 2
fields = {}
if mode == 'fixed-young':
    fields = {
        'Peak RssAnon MiB': lambda r: r['peak_anon_mib'],
        'End RssAnon MiB': lambda r: r['end_anon_mib'],
        'Post-build heapUsed MiB': lambda r: r['heap']['used_heap_size'] / MIB,
        'Post-build V8 physical MiB': lambda r: r['heap']['total_physical_size'] / MIB,
        'Post-GC heapUsed MiB': lambda r: r['post_gc']['heap']['used_heap_size'] / MIB,
        'Post-GC V8 physical MiB': lambda r: r['post_gc']['heap']['total_physical_size'] / MIB,
        'Post-GC RssAnon MiB': lambda r: r['post_gc']['anon_mib'],
    }
    for kind in [1, 4, 8, 16]:
        fields[f'GC kind {kind} count'] = lambda r, kind=kind: r['gc'].get(str(kind), {}).get('count', 0)
else:
    fields['Initial RssAnon MiB'] = lambda r: r['points'][0]['end_anon_mib']
    fields['Initial +10s RssAnon MiB'] = lambda r: r['initial_idle']['anon_mib']
    for index in range(1, 6):
        fields[f'Rebuild {index} RssAnon MiB'] = lambda r, index=index: r['points'][index]['end_anon_mib']
    fields['Last +10s RssAnon MiB'] = lambda r: r['final_idle']['anon_mib']
    fields['Post-GC heapUsed MiB'] = lambda r: r['post_gc']['heap']['used_heap_size'] / MIB
    fields['Post-GC V8 physical MiB'] = lambda r: r['post_gc']['heap']['total_physical_size'] / MIB
    fields['Post-GC RssAnon MiB'] = lambda r: r['post_gc']['anon_mib']
    for index in range(1, 6):
        fields[f'Rebuild {index} wall s'] = lambda r, index=index: r['points'][index]['wall_ms'] / 1000
    fields['Rebuild wall median s'] = lambda r: st.median(p['wall_ms'] / 1000 for p in r['points'][1:])
host = json.loads((root / 'host.json').read_text())
summary = {'mode': mode, 'host': host, 'medians': {}, 'pairs': {}, 'parity': json.loads((root / 'memory-parity.json').read_text())}
lines = [f'# Round 2 {mode}', '', f"Run: {host['run_url']}; commit `{host['commit']}`", '', 'Five interleaved U0 / U0prime / U2r2 triples per variant. Signs are negative/zero/positive paired differences. Exact two-sided Wilcoxon uses average ranks for ties and drops zeros. At n=5 the minimum p is 0.0625.', '', 'Fixed young generation: --min-semi-space-size=16 --max-semi-space-size=16 for every arm, Node 22.18.0. Endpoint before collection, followed by two forced GCs in each sample. GC kinds: 1 minor, 4 major, 8 incremental, 16 weak callbacks.' if mode == 'fixed-young' else 'Watch: default V8 flags, one process per sample, initial build, 10s idle, five alternating content edits with 3s gaps, 10s idle after last rebuild, then two forced GCs while the compiler remains live. Rebuild wall starts immediately before the edit and includes watch debounce.', '']
for variant in ['broad', 'narrow']:
    groups = {arm: sorted([r for r in rows if r['variant'] == variant and r['arm'] == arm], key=lambda r: r['tag']) for arm in ['U0', 'U0prime', 'U2r2']}
    assert all(len(group) == 5 for group in groups.values())
    assert all([r['tag'] for r in group] == [r['tag'] for r in groups['U0']] for group in groups.values())
    summary['medians'][variant] = {arm: {name: st.median(fn(r) for r in group) for name, fn in fields.items()} for arm, group in groups.items()}
    summary['pairs'][variant] = {}
    lines += [f'## {variant}', '', '| Metric | U0 | U0prime | U2r2 | U2r2-U0 | Exact p | Signs | U0prime-U0 (A/A) | Exact p | Signs |', '|---|---:|---:|---:|---:|---:|---|---:|---:|---|']
    for name, fn in fields.items():
        values = {arm: [fn(r) for r in group] for arm, group in groups.items()}
        candidate, aa = paired(values['U0'], values['U2r2']), paired(values['U0'], values['U0prime'])
        summary['pairs'][variant][name] = {'candidate': candidate, 'aa': aa}
        def signs(p): return f"{p['negative']}/{p['zero']}/{p['positive']}"
        med = summary['medians'][variant]
        lines.append(f"| {name} | {med['U0'][name]:.3f} | {med['U0prime'][name]:.3f} | {med['U2r2'][name]:.3f} | {candidate['median']:+.3f} | {candidate['p']:.4f} | {signs(candidate)} | {aa['median']:+.3f} | {aa['p']:.4f} | {signs(aa)} |")
    lines += ['']
lines += ['Linux synthetic fixture only. RssAnon includes native live allocations and allocator capacity; V8 physical is capacity, not retained object bytes. Forced-GC used heap does not establish zero native retention. No equivalence, causal or cross-platform claim follows from n=5 or from nonsignificant p values.', '']
(root / 'memory-summary.json').write_text(json.dumps(summary, indent=2))
(root / f'{mode}-report.md').write_text('\n'.join(lines))
print('\n'.join(lines))
