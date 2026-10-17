import json
import pathlib

root = pathlib.Path('bench-data/results')
metrics = {'peakRss': 'Peak RSS / working set', 'snapshots.end.process.rss': 'Build-end RSS / working set', 'snapshots.postGc.process.rss': 'Post-GC RSS / working set'}
print('| OS | Fixture | Metric (MiB) | Base #44 median | Prototype median | Change |')
print('| --- | --- | --- | ---: | ---: | ---: |')
summaries = {}
for count in [1, 5]:
    folder = root / f'loaders-{count}'
    summary = json.loads((folder / 'summary.json').read_text())
    summaries[count] = summary
    for row in summary['rows']:
        if row['metric'] in metrics:
            print(f"| {summary['environment']['platform']} | {count} | {metrics[row['metric']]} | {row['baseMedian']/1048576:.3f} | {row['prMedian']/1048576:.3f} | {row['percent']:+.2f}% |")
for count, summary in summaries.items():
    primary = [row for row in summary['rows'] if row['metric'] in metrics]
    print(f"\n{count} loaders: primary memory increase detected = {any(row['increased'] for row in primary)}; measured processes = {summary['samples']}; output parity = {summary['parity']['identical']}.")
    print('Native SHA-256:', json.dumps(summary['parity']['bindings']))
    print('Core SHA-256:', (root / f'loaders-{count}' / 'core-manifest.json').read_text())
    print('Output files:', json.dumps(summary['parity']['files']))
