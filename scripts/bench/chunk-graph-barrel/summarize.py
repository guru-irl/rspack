import json
import re
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1])
rows = []
parity = 0

def selected(record, key):
    entries = record['logging'].get(key, {}).get('entries', [])
    for entry in entries:
        match = re.search(r'(\d+) (?:modules|chunks) are affected, (\d+) in total', entry['message'])
        if match:
            return int(match.group(1))
    raise AssertionError(f'Missing selection count: {key}')

def timer(record, name):
    for entry in record['logging']['rspack.Compilation']['entries']:
        if entry['type'] == 'time' and entry['message'].startswith(name + ': '):
            return float(entry['message'][len(name) + 2:].split()[0])
    # Reuse skips the build timer entirely.
    if name == 'rebuild chunk graph':
        return 0.0
    raise AssertionError(f'Missing timer: {name}')

for split in [0, 1]:
    samples = {'main': [], 'fix': []}
    for pair in range(1, 6):
        members = {}
        for variant in ['main', 'fix']:
            members[variant] = json.loads((root / f'{split}-{pair}-{variant}.json').read_text())
            data = members[variant]
            assert len(data['records']) == 3
            edit = data['records'][1]
            samples[variant].append({
                'pair': pair, 'wallMs': edit['wallMs'],
                'moduleHashes': selected(edit, 'rspack.incremental.modulesHashes'),
                'chunkHashes': selected(edit, 'rspack.incremental.chunksHashes'),
                'chunkAssets': selected(edit, 'rspack.incremental.chunkAsset'),
                'moduleHashMs': timer(edit, 'create module hashes'),
                'chunkHashMs': timer(edit, 'hashing'),
                'chunkAssetMs': timer(edit, 'create chunk assets'),
                'rebuildChunkGraphMs': timer(edit, 'rebuild chunk graph'),
                'peakRss': data['peakRss'], 'steadyEndRss': data['steadyEndRss'], 'endRss': data['endRss'],
                'editRss': edit['rss'],
            })
        for a, b in zip(members['main']['records'], members['fix']['records']):
            assert a['label'] == b['label']
            assert a['outputs'] == b['outputs'], f'Byte parity failed: split={split} pair={pair} label={a["label"]}'
            parity += 1
        assert members['main']['records'][0]['outputs'] == members['main']['records'][2]['outputs']
        assert members['fix']['records'][0]['outputs'] == members['fix']['records'][2]['outputs']
    medians = {variant: {key: statistics.median(x[key] for x in items) for key in items[0] if key != 'pair'} for variant, items in samples.items()}
    saving = {key: medians['main'][key] - medians['fix'][key] for key in medians['main']}
    paired = {key: statistics.median(a[key] - b[key] for a, b in zip(samples['main'], samples['fix'])) for key in medians['main']}
    rows.append({'split': bool(split), 'samples': samples, 'medians': medians, 'medianDifferences': saving, 'pairedMedianDifferences': paired})
summary = {'pairedN': 5, 'parityBuilds': parity, 'rows': rows}
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
