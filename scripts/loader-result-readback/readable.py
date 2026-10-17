import json
import pathlib

root = pathlib.Path('bench-data/results')
print('| Fixture | Metric | Base #44 median | Prototype median | Change |')
print('| --- | --- | ---: | ---: | ---: |')
labels = {'buildMs': 'Build wall (s)', 'mainCpuMs': 'Main-thread CPU (s)', 'peakRss': 'Peak RSS (MiB)', 'steadyRss': 'Build-end RSS (MiB)', 'idleRss': 'Post-GC RSS (MiB)'}
summaries = {}
for fixture, name in [('one', '1 loader'), ('five', '5 loaders')]:
    summary = json.loads((root / fixture / 'summary.json').read_text())
    summaries[fixture] = summary
    for row in summary['rows']:
        if row['metric'] not in labels:
            continue
        scale = 1048576 if row['metric'].endswith('Rss') else 1000
        print(f"| {name} | {labels[row['metric']]} | {row['baseMedian']/scale:.3f} | {row['prMedian']/scale:.3f} | {row['percent']:+.2f}% |")
for fixture, summary in summaries.items():
    print(f"\n{fixture}: CPU clearly lower = {summary['cpuClearlyLower']}; memory increase detected = {summary['memoryIncreaseDetected']}; complete output parity = {summary['parity']['identical']}.")
    result = json.loads((root / fixture / 'census-pr.json').read_text())
    census = json.loads((root / fixture / 'census-pr.json.chains.json').read_text())
    core = json.loads((root / fixture / 'core-manifest.json').read_text())
    assert result['bindingSha256'] == summary['parity']['bindings']['pr']
    assert result['coreSha256'] == core['pr']
    assert result['outputFiles'] == summary['parity']['files']
    assert census['exitCode'] == 0 and census['distinctChains'] == 4
    assert census['loaderEntries'] == (7 if fixture == 'one' else 23)
    print(f"Untimed cache census: {census['distinctChains']} distinct chains, {census['loaderEntries']} loader entries, {census['stringUtf8Bytes']} UTF-8 bytes of metadata strings (not total allocation size).")
    print('Native SHA-256:', json.dumps(summary['parity']['bindings']))
    print('Core SHA-256:', json.dumps(core))
    print('Output files:', json.dumps(summary['parity']['files']))
