import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'loader-result-readback'))
from exact import paired_location

root = Path(sys.argv[1])
protocol = json.loads((root / 'protocol.json').read_text())
schedule = json.loads((root / 'schedule.json').read_text())
measured = [item for item in schedule if item['round'] > 0 and not item['diagnostic']]
rows = [(item, json.loads((root / item['file']).read_text())) for item in measured]
metrics = {
    'wall_ms': lambda r: r['buildMs'],
    'main_cpu_ms': lambda r: r['mainCpuMs'],
    'process_cpu_ms': lambda r: sum(r['processCpuUs'].values()) / 1000,
    'peak_rss_bytes': lambda r: r['peakRss'],
    'end_rss_bytes': lambda r: r['steadyRss'],
    'close_rss_bytes': lambda r: r['closeRss'],
    'post_gc_rss_bytes': lambda r: r['idleRss'],
    'gc_duration_ms': lambda r: r['gcActivity']['durationMs'],
    'gc_count': lambda r: r['gcActivity']['count'],
}
for endpoint in ['end', 'close', 'postGc']:
    for key in ['used_heap_size', 'total_heap_size', 'total_physical_size', 'malloced_memory', 'external_memory']:
        metrics[f'{endpoint}_v8_{key}_bytes'] = lambda r, endpoint=endpoint, key=key: r['snapshots'][endpoint]['v8'][key]
    for key in ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']:
        metrics[f'{endpoint}_process_{key}_bytes'] = lambda r, endpoint=endpoint, key=key: r['snapshots'][endpoint]['process'][key]
    metrics[f'{endpoint}_native_estimate_bytes'] = lambda r, endpoint=endpoint: r['snapshots'][endpoint]['nativeEstimate']

def medians(data):
    return {name: statistics.median(values) for name, get in metrics.items() if all((value := get(row)) is not None for row in data) and (values := [get(row) for row in data])}

summary = {'protocol': protocol, 'environment': json.loads((root / 'environment.json').read_text()), 'identities': json.loads((root / 'identity-manifest.json').read_text()), 'cells': {}, 'costs': {}, 'comparison': {}, 'diagnostics': {}}
lines = [f"# {protocol['phase']}: {protocol['platform']}", '']
if protocol['phase'] == 'S1':
    if len(rows) != 5 * len(protocol['cells']):
        raise ValueError('Incomplete fixed schedule')
    for cell in protocol['cells']:
        data = [r for item, r in rows if item['cell'] == cell]
        if len(data) != 5:
            raise ValueError('Incomplete cell')
        summary['cells'][cell] = {'medians': medians(data), 'outputFiles': data[0]['outputFiles'], 'moduleCounts': sorted({r['moduleCount'] for r in data}), 'warningCounts': sorted({r['warningCount'] for r in data}), 'errorCounts': sorted({r['errorCount'] for r in data})}
        summary['diagnostics'][cell] = json.loads((root / f'diagnostic-{cell}.json').read_text())['diagnosticCounts']
    contrasts = [
        ('per_crossing', 'K0', 'K1', 60701),
        ('per_extra_loader', 'K1', 'K5', 4 * 60701),
        ('per_extra_segment', 'K5', 'SEG2', 60701),
        ('per_removed_crossing_at_five_loaders', 'F5', 'K5', 60701 - 3035),
        ('per_rule_callback', 'RRE', 'RFN', 8 * 60701),
    ]
    for name, base, treatment, units in contrasts:
        if base not in protocol['cells'] or treatment not in protocol['cells']:
            continue
        cost = {'base': base, 'treatment': treatment, 'units': units, 'metrics': {}}
        for metric, get in metrics.items():
            values = []
            for round_id in range(1, 6):
                b = next(r for item, r in rows if item['round'] == round_id and item['cell'] == base)
                t = next(r for item, r in rows if item['round'] == round_id and item['cell'] == treatment)
                if get(b) is None or get(t) is None:
                    break
                multiplier = 1000 if metric.endswith('_ms') else 1
                values.append((get(t) - get(b)) * multiplier / units)
            if len(values) == 5:
                cost['metrics'][metric] = {'median': statistics.median(values), 'range': [min(values), max(values)], 'rounds': values, 'unit': 'us/unit' if metric.endswith('_ms') else 'bytes/unit' if metric.endswith('_bytes') else 'count/unit'}
        summary['costs'][name] = cost
    lines += ['## Per-unit costs', '', '| Contrast | Main CPU us/unit, median [range] | Wall us/unit, median [range] | Peak bytes/unit [range] | End bytes/unit [range] | Post-GC bytes/unit [range] |', '| --- | ---: | ---: | ---: | ---: | ---: |']
    def cost_cell(cost, metric):
        item = cost['metrics'].get(metric)
        return 'n/a' if item is None else f"{item['median']:.3f} [{item['range'][0]:.3f}, {item['range'][1]:.3f}]"
    for name, cost in summary['costs'].items():
        lines.append('| ' + name + ' | ' + ' | '.join(cost_cell(cost, key) for key in ['main_cpu_ms', 'wall_ms', 'peak_rss_bytes', 'end_rss_bytes', 'post_gc_rss_bytes']) + ' |')
else:
    if len(rows) != 20:
        raise ValueError('Incomplete paired schedule')
    for arm in ['OFFICIAL-229', 'CANARY-96dcd72d']:
        data = [r for item, r in rows if item['arm'] == arm]
        summary['cells'][arm] = {'medians': medians(data), 'outputFiles': data[0]['outputFiles'], 'moduleCounts': sorted({r['moduleCount'] for r in data}), 'warningCounts': sorted({r['warningCount'] for r in data}), 'errorCounts': sorted({r['errorCount'] for r in data})}
    for metric, get in metrics.items():
        base, treatment = [], []
        for round_id in range(1, 11):
            b = next(r for item, r in rows if item['round'] == round_id and item['arm'] == 'OFFICIAL-229')
            t = next(r for item, r in rows if item['round'] == round_id and item['arm'] == 'CANARY-96dcd72d')
            if get(b) is None or get(t) is None:
                break
            base.append(get(b))
            treatment.append(get(t))
        if len(base) != 10:
            continue
        bmed, tmed = statistics.median(base), statistics.median(treatment)
        summary['comparison'][metric] = {'baseMedian': bmed, 'canaryMedian': tmed, 'percent': (tmed / bmed - 1) * 100 if bmed else None, 'pairedMedian': statistics.median(t - b for b, t in zip(base, treatment)), 'deltas': [t - b for b, t in zip(base, treatment)], **paired_location(base, treatment)}
    lines += ['## Canary minus official', '', '| Metric | Official median | Canary median | Change % | HL delta | Exact 95% |', '| --- | ---: | ---: | ---: | ---: | --- |']
    for metric, item in summary['comparison'].items():
        percent = 'n/a' if item['percent'] is None else f"{item['percent']:+.3f}"
        lines.append(f"| {metric} | {item['baseMedian']:.3f} | {item['canaryMedian']:.3f} | {percent} | {item['hodgesLehmann']:+.3f} | {item['exact95']} |")
lines += ['', '## Cell medians', '', '| Cell | Wall s | Main CPU s | Process CPU s | Peak MiB | End MiB | Post-close MiB | Post-GC MiB |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for cell, value in summary['cells'].items():
    values = value['medians']
    def formatted(key, divisor):
        return 'n/a' if key not in values else f'{values[key] / divisor:.3f}'
    lines.append('| ' + cell + ' | ' + ' | '.join(formatted(key, divisor) for key, divisor in [('wall_ms', 1000), ('main_cpu_ms', 1000), ('process_cpu_ms', 1000), ('peak_rss_bytes', 2**20), ('end_rss_bytes', 2**20), ('close_rss_bytes', 2**20), ('post_gc_rss_bytes', 2**20)]) + ' |')
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
(root / 'summary.md').write_text('\n'.join(lines) + '\n')
print('\n'.join(lines))
