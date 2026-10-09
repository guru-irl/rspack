import itertools
import json
import pathlib
import statistics as st

root = pathlib.Path('results')
rows = [json.loads(line) for line in (root / 'samples.jsonl').read_text().splitlines()]
MIB = 1024 ** 2
host = json.loads((root / 'host.json').read_text())
arms = ['U0', 'U1', 'U2', 'RX']

def group(series, variant, phase, arm):
    return sorted([r for r in rows if (r['series'], r['variant'], r['phase'], r['arm']) == (series, variant, phase, arm)], key=lambda r: r['tag'])

def wilcoxon(deltas):
    values = sorted((abs(d), d > 0) for d in deltas if d != 0)
    if not values:
        return {'n': 0, 'Wplus': 0, 'p_two_sided': 1}
    ranks = []
    i = 0
    while i < len(values):
        j = i + 1
        while j < len(values) and values[j][0] == values[i][0]:
            j += 1
        rank = ((i + 1) + j) / 2
        ranks.extend((rank, values[k][1]) for k in range(i, j))
        i = j
    observed = sum(rank for rank, positive in ranks if positive)
    total = sum(rank for rank, _ in ranks)
    distance = abs(observed - total / 2)
    extreme = sum(abs(sum(rank for (rank, _), positive in zip(ranks, signs) if positive) - total / 2) >= distance for signs in itertools.product([False, True], repeat=len(ranks)))
    return {'n': len(ranks), 'Wplus': observed, 'p_two_sided': extreme / 2 ** len(ranks)}

fields = {
    'wall_s': lambda r: r['wall_ms'] / 1000,
    'cpu_s': lambda r: r['cpu_ms'] / 1000,
    'make_s': lambda r: r['phase_split']['make_ms'] / 1000,
    'peak_anon_mib': lambda r: r['peak_anon_mib'],
    'end_anon_mib': lambda r: r['end_anon_mib'],
    'heap_used_mib': lambda r: r['heap']['used_heap_size'] / MIB,
    'heap_total_mib': lambda r: r['heap']['total_heap_size'] / MIB,
    'heap_physical_mib': lambda r: r['heap']['total_physical_size'] / MIB,
    'minor_gc': lambda r: r['gc'].get('1', {}).get('count', 0),
    'major_gc': lambda r: r['gc'].get('4', {}).get('count', 0),
}
summary = {'host': host, 'medians': {}, 'pairs': {}, 'gc_controls': {}, 'parity': json.loads((root / 'parity.json').read_text())}
lines = ['# Synthetic unplugin loader filter cache', '', '## Method', '', f"Commit: `{host['commit']}`; run: {host['run_url']}", '', f"Host: {host['cpu_model']}, {host['cpus']} CPUs, {host['ram_mib']:.1f} MiB, Node {host['node']}, {host['platform']}. Initial load {host['load']}.", '', '- U0: stock unplugin 3.4.0. U1: rule callback filters hoisted. U2: U1 plus per-hook WeakMap filter caches in four rspack/webpack loaders; handlers read fresh. RX: stock with string patterns converted to equivalent picomatch-generated regexes once before timing.', '- Released @rspack/core 2.2.8; one 60,000-leaf-module fixture plus entry. Broad include matches all 60,001 modules; narrow matches 1,800. Both use two excludes. Transform returns code unchanged and load returns null.', '- n=5 fresh-process cold/warm pairs per arm/variant, interleaved in a four-order balanced design followed by a fifth reverse-order repeat; variant order alternates. Warm newCache restores only its preceding own cold cache. No OS page-cache flush. Caches removed after each recorded pair.', '- Wall and process CPU from before compiler creation through done. Make interval: make to finishMake. RssAnon externally sampled at 10 ms and captured at done. V8 endpoint snapshots at done. GC counts filtered by timestamps to that build window.', '- Timed processes do not force GC. Separate excluded n=1 cold/warm process pairs per arm/variant force GC twice after done and output/attachment parity checks. These control footprints retain the compiler and compilation; they are not a steady-state guarantee.', '- Actual loader lifetimes are wrapped in every arm identically. Identity counters use WeakSets, checking stable query/plugin/hook identity without retaining one entry per module. Shared instrumentation can affect absolute numbers.', '- All emitted bytes, callback counts, loader counts, attachment digests, restore counts, registry integrity, touched-file hashes and shared dependency hashes asserted. RX changes pattern representation, not matching semantics for these synthetic filters.', '- Filters are cached separately in each loader module, not globally across adapters or rule filters. Filters replaced or mutated after first use are not recompiled; handler replacements are visible. RegExp objects referenced by compiled filters remain live.', '', '## Per-arm medians, n=5', '']
for variant in ['broad', 'narrow']:
    for phase in ['cold', 'warm']:
        key = f'{variant}/{phase}'
        groups = {arm: group('default', variant, phase, arm) for arm in arms}
        assert all(len(value) == 5 for value in groups.values())
        summary['medians'][key] = {}
        lines += [f'### {key}', '', '| Arm | Wall s | CPU s | Make s | Peak anon MiB | End anon MiB | Heap used MiB | Heap total MiB | Heap physical MiB | Minor GC | Major GC |', '|---|' + '---:|' * 10]
        for arm, values in groups.items():
            medians = {name: st.median(fn(r) for r in values) for name, fn in fields.items()}
            summary['medians'][key][arm] = medians
            lines.append(f'| {arm} | ' + ' | '.join(f'{value:.3f}' for value in medians.values()) + ' |')
        lines += ['', '| Comparison, right minus left | Paired wall s | Paired wall % | Exact wall p | Paired CPU s | Exact CPU p | Paired make s | Exact make p | Peak MiB | End MiB |', '|---|' + '---:|' * 9]
        summary['pairs'][key] = {}
        for left, right in [('U0', 'U1'), ('U0', 'U2'), ('U0', 'RX'), ('U1', 'U2'), ('U1', 'RX'), ('RX', 'U2')]:
            a, b = groups[left], groups[right]
            assert [r['tag'] for r in a] == [r['tag'] for r in b]
            deltas = {name: [fn(y) - fn(x) for x, y in zip(a, b)] for name, fn in fields.items()}
            percentages = {name: [(fn(y) / fn(x) - 1) * 100 for x, y in zip(a, b)] for name, fn in fields.items() if name not in ['minor_gc', 'major_gc']}
            tests = {name: wilcoxon(values) for name, values in deltas.items()}
            pair = {'paired_medians': {name: st.median(values) for name, values in deltas.items()}, 'paired_pct_medians': {name: st.median(values) for name, values in percentages.items()}, 'wilcoxon': tests, 'deltas': deltas}
            summary['pairs'][key][f'{right}-{left}'] = pair
            m = pair['paired_medians']
            vals = [m['wall_s'], pair['paired_pct_medians']['wall_s'], tests['wall_s']['p_two_sided'], m['cpu_s'], tests['cpu_s']['p_two_sided'], m['make_s'], tests['make_s']['p_two_sided'], m['peak_anon_mib'], m['end_anon_mib']]
            lines.append(f'| {right}-{left} | ' + ' | '.join(f'{value:+.3f}' if i not in [2, 4, 6] else f'{value:.4f}' for i, value in enumerate(vals)) + ' |')
        lines += ['', '| Arm | use | include | include true | transform handlers | load handlers | build | valid | transform plugin/hook/query identities | load plugin/hook/query identities |', '|---|' + '---:|' * 9]
        for arm, values in groups.items():
            r = values[0]
            assert all(item['counts'] == r['counts'] for item in values)
            counts = [r['counts'][name] for name in ['use', 'include', 'include_true', 'transform', 'load', 'build', 'valid']]
            ids = ['/'.join(str(r['identity'][kind][name]) for name in ['plugin_count', 'hook_count', 'query_count']) for kind in ['transform', 'load']]
            lines.append(f'| {arm} | ' + ' | '.join(map(str, counts + ids)) + ' |')
        lines += ['']
        summary['gc_controls'][key] = {}
        lines += ['| Excluded forced-GC control, n=1 | End heap used MiB | End heap total MiB | End physical MiB | Post-GC heap used MiB | Post-GC heap total MiB | Post-GC physical MiB | Post-GC anon MiB |', '|---|' + '---:|' * 7]
        for arm in arms:
            controls = group('gc-control', variant, phase, arm)
            assert len(controls) == 1
            r = controls[0]
            control = {**{f'end_{name}': fields[name](r) for name in ['heap_used_mib', 'heap_total_mib', 'heap_physical_mib']}, 'post_heap_used_mib': r['post_gc']['heap']['used_heap_size'] / MIB, 'post_heap_total_mib': r['post_gc']['heap']['total_heap_size'] / MIB, 'post_heap_physical_mib': r['post_gc']['heap']['total_physical_size'] / MIB, 'post_anon_mib': r['post_gc']['anon_mib']}
            summary['gc_controls'][key][arm] = control
            lines.append(f'| {arm} | ' + ' | '.join(f'{value:.3f}' for value in control.values()) + ' |')
        lines += ['']
lines += ['## Statistical and memory limits', '', '- Paired medians are medians of per-repeat differences and percentages, not differences or ratios of independent arm medians.', '- Exact two-sided Wilcoxon enumerates all sign assignments to absolute nonzero paired ranks; average ranks for ties; zeros dropped. At n=5 the minimum possible p is 0.0625. No p<0.05 or multiple-comparison significance claim is supported.', '- Peak and end anonymous RSS include allocator behavior and native memory; V8 physical is not an exact partition of RssAnon. The forced-GC controls are one excluded process per condition, not a production lifetime or steady-state memory bound.', '- Full raw samples, V8 spaces, GC events, RSS traces, lifecycle timestamps, identity/work counts and package/dependency digests are included.', '']
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
(root / 'u2-runner-report.md').write_text('\n'.join(lines))
print(json.dumps(summary['pairs'], indent=2))
