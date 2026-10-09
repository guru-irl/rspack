import itertools
import json
import pathlib
import statistics as st

root = pathlib.Path('results')
rows = [json.loads(line) for line in (root / 'samples.jsonl').read_text().splitlines()]
MIB = 1024 ** 2
host = json.loads((root / 'host.json').read_text())

def get(series, variant, phase, arm):
    return sorted([r for r in rows if (r['series'], r['variant'], r['phase'], r['arm']) == (series, variant, phase, arm)], key=lambda r: r['tag'])

def wilcoxon(deltas):
    values = [(abs(d), d > 0) for d in deltas if d != 0]
    if not values:
        return {'n': 0, 'Wplus': 0, 'p_two_sided': 1}
    values.sort()
    ranks = []
    i = 0
    while i < len(values):
        j = i + 1
        while j < len(values) and values[j][0] == values[i][0]:
            j += 1
        rank = ((i + 1) + j) / 2
        ranks.extend([(rank, values[k][1]) for k in range(i, j)])
        i = j
    observed = sum(rank for rank, positive in ranks if positive)
    total = sum(rank for rank, _ in ranks)
    distance = abs(observed - total / 2)
    extreme = 0
    for signs in itertools.product([False, True], repeat=len(ranks)):
        w = sum(rank for (rank, _), positive in zip(ranks, signs) if positive)
        extreme += abs(w - total / 2) >= distance
    return {'n': len(ranks), 'Wplus': observed, 'p_two_sided': extreme / 2 ** len(ranks)}

def median(group, fn):
    return st.median(fn(r) for r in group)

def gc_count(r, kind):
    return r['gc'].get(str(kind), {}).get('count', 0)

def gc_ms(r):
    return sum(x['duration_ms'] for x in r['gc'].values())

def concurrency(r):
    samples = [s['active'] for s in r['loader']['samples'] if r['timestamps']['make'] <= s['ms'] <= r['timestamps']['finishMake']]
    return st.median(samples) if samples else 0

lines = ['# Synthetic unplugin filter follow-up', '', '## Environment and integrity', '', f"- Commit: `{host['commit']}`; run: {host['run_url']}", f"- Host: {host['cpu_model']}; {host['cpus']} logical CPUs; RAM {host['ram_mib']:.0f} MiB; Node {host['node']}; platform {host['platform']}", f"- Initial load: {host['load']}; no concurrent benchmark jobs. Released npm packages: @rspack/core 2.2.8, unplugin 3.4.0; binding and transitive versions are in package-lock and dependency hashes.", '- One synthetic 60,000-leaf-module fixture plus entry. Broad matches 60,001 modules; narrow matches 1,800 (3% of leaves). Both filters have two string excludes. Transform returns code unchanged; load returns null.', '- Five fresh processes per arm/variant/phase; cold uses empty persistent filesystem cache, warm newCache uses only its own preceding cold cache. Cold/warm pairs are interleaved by arm; complete arm order alternates stock/patched/none and none/patched/stock. Variant order also alternates by repeat. Cache persistence and close are outside timing; no OS page-cache flush.', '- Registry tarball SHA-1/SHA-512, before/after dist hashes, two-file-only package differences and shared dependency digests checked. Per-run loader work, cold/warm restore counts, attachment parity and emitted-byte parity asserted. Shared dependencies and dist hashes rechecked after the series.', '- Wall and process user+system CPU measured from immediately before compiler creation through done hook. RssAnon sampled externally at 10 ms with endpoint captured at done, before output scan and forced GC. Peak is at least endpoint. Endpoints are not steady-state memory guarantees.', '- V8 heap/spaces captured at done; perf_hooks GC entries filtered to the build window. Summed event duration is not a full pause/CPU profile. Two forced GCs occur after timing, attachment scan and output hashing.', '- Actual transform/load loader wrappers count from invocation through sync/promise/callback completion without artificial delay. Broad in-flight samples are taken every 50 ms; median is over make-to-finishMake, including zeros; sampled maximum and exact event maximum are both reported. Sub-50-ms activity and delayed timers can be missed.', '- Hook intervals: setup = start→make, make = make→finishMake, compile = finishMake→afterCompile, emit = afterCompile→done. These are lifecycle intervals, not disjoint native-thread CPU attribution.', '', '## Per-arm medians', '']
summary = {}
for series in ['default', 'semi64']:
    for variant in ['broad', 'narrow']:
        for phase in ['cold', 'warm']:
            arms = ['stock', 'patched', 'none'] if series == 'default' else ['stock', 'patched']
            groups = {arm: get(series, variant, phase, arm) for arm in arms}
            if not groups['stock']:
                continue
            label = f'{series} / {variant} / {phase}'
            lines += [f'### {label}', '', '| Arm | n | Wall s | CPU s | Peak anon MiB | End anon MiB | Heap used MiB | V8 physical MiB | Minor GC | Major GC | GC ms |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
            for arm, group in groups.items():
                vals = [median(group, lambda r: r['wall_ms']) / 1000, median(group, lambda r: r['cpu_ms']) / 1000, median(group, lambda r: r['peak_anon_mib']), median(group, lambda r: r['end_anon_mib']), median(group, lambda r: r['heap']['used_heap_size']) / MIB, median(group, lambda r: r['heap']['total_physical_size']) / MIB, median(group, lambda r: gc_count(r, 1)), median(group, lambda r: gc_count(r, 4)), median(group, gc_ms)]
                lines.append(f'| {arm} | {len(group)} | ' + ' | '.join(f'{v:.3f}' for v in vals) + ' |')
            lines += ['', '| Arm | Setup s | Make s | Compile s | Emit s | use | include | include true | Transform | Load | Built | Valid | Loader median | Sample max | Exact max |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
            for arm, group in groups.items():
                vals = [median(group, lambda r: r['phase_split'][key]) / 1000 for key in ['setup_ms', 'make_ms', 'compile_ms', 'emit_ms']]
                vals += [median(group, lambda r: r['counts'][key]) for key in ['use', 'include', 'include_true', 'transform', 'load', 'build', 'valid']]
                vals += [median(group, concurrency), median(group, lambda r: max([s['active'] for s in r['loader']['samples']], default=0)), median(group, lambda r: r['loader']['max_exact'])]
                lines.append(f'| {arm} | ' + ' | '.join(f'{v:.3f}' if i < 4 else f'{v:g}' for i, v in enumerate(vals)) + ' |')
            stock, patched = groups['stock'], groups['patched']
            fields = {'wall_ms': lambda r: r['wall_ms'], 'cpu_ms': lambda r: r['cpu_ms'], 'peak_anon_mib': lambda r: r['peak_anon_mib'], 'end_anon_mib': lambda r: r['end_anon_mib'], 'heap_used_mib': lambda r: r['heap']['used_heap_size'] / MIB, 'v8_physical_mib': lambda r: r['heap']['total_physical_size'] / MIB, 'gc_ms': gc_ms}
            fields.update({key: lambda r, key=key: r['phase_split'][key] for key in ['setup_ms', 'make_ms', 'compile_ms', 'emit_ms']})
            deltas = {key: [fn(b) - fn(a) for a, b in zip(stock, patched)] for key, fn in fields.items()}
            wall_pct = [(b['wall_ms'] / a['wall_ms'] - 1) * 100 for a, b in zip(stock, patched)]
            test = wilcoxon(deltas['wall_ms'])
            summary[label] = {'paired_medians': {k: st.median(v) for k, v in deltas.items()}, 'wall_pct_median': st.median(wall_pct), 'wilcoxon': test, 'wall_deltas_ms': deltas['wall_ms']}
            lines += ['', f"Paired patched−stock wall: **{st.median(deltas['wall_ms']) / 1000:+.3f} s ({st.median(wall_pct):+.2f}%)**; exact two-sided Wilcoxon W+={test['Wplus']:g}, n={test['n']}, p={test['p_two_sided']:.4f}.", '', '| Pair | Wall ms | CPU ms | Peak MiB | End MiB | Heap MiB | Physical MiB | GC ms | Setup ms | Make ms | Compile ms | Emit ms |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
            for i, a in enumerate(stock):
                lines.append(f"| {a['tag']} | " + ' | '.join(f'{deltas[k][i]:+.3f}' for k in fields) + ' |')
            lines.append('| Median | ' + ' | '.join(f'{st.median(deltas[k]):+.3f}' for k in fields) + ' |')
            lines += ['', '| Arm, post-build forced-GC control | Heap used MiB | V8 physical MiB | RssAnon MiB |', '|---|---:|---:|---:|']
            for arm, group in groups.items():
                lines.append(f"| {arm} | {median(group, lambda r: r['post_gc']['heap']['used_heap_size']) / MIB:.3f} | {median(group, lambda r: r['post_gc']['heap']['total_physical_size']) / MIB:.3f} | {median(group, lambda r: r['post_gc']['anon_mib']):.3f} |")
            lines += ['']
lines += ['## Mechanism probe and statistical limits', '', (root / 'probe-decision.json').read_text(), '', '- The semi64 probe, when run, changes only NODE_OPTIONS=--max-semi-space-size=64, with three alternating stock/patched cold pairs and otherwise identical work. It tests young-generation sizing sensitivity; disappearance of the penalty supports that mechanism but does not by itself isolate loader scheduling.', '- Exact Wilcoxon enumerates every sign assignment of nonzero absolute paired ranks, using average ranks for ties; zero deltas are dropped. This is an exact conditional two-sided test. With n=5 the smallest possible p is 0.0625, and with n=3 it is 0.25, so neither series can attain p<0.05. No multiple-comparison significance claim is made.', '- Hook, GC, heap and sampled concurrency correlations do not establish a unique cause. Published loader normalization still allocates filters on cold executions: filters-once here refers only to rule use/include matching.', '- Raw per-run heap spaces, GC events, callback counts, phase timestamps, 10-ms RSS and 50-ms concurrency traces are retained in samples.jsonl. Runner logs, dependency hashes and installation lock are included in the artifact.', '']
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
(root / 'followup-report.md').write_text('\n'.join(lines))
print(json.dumps(summary, indent=2))
