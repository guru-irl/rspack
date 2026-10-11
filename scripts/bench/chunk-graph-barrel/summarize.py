import json
import os
import re
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1])
base = os.environ.get('BASE_VARIANT', 'main')
fix = os.environ.get('FIX_VARIANT', 'fix')
rows = []
parity = 0

def selected(record, key):
    for entry in record['logging'].get(key, {}).get('entries', []):
        match = re.search(r'(\d+) (?:modules|chunks) are affected, (\d+) in total', entry['message'])
        if match:
            return int(match.group(1))
    raise AssertionError(f'Missing selection count: {key}')

def timer(record, name):
    for entry in record['logging']['rspack.Compilation']['entries']:
        match = re.fullmatch(re.escape(name) + r': ([\d.eE+-]+) ms', entry['message'])
        if entry['type'] == 'time' and match:
            return float(match.group(1))
    if name == 'rebuild chunk graph':
        return 0.0
    raise AssertionError(f'Missing timer: {name}')

def metrics(record):
    return {
        'wallMs': record['wallMs'],
        'moduleHashes': selected(record, 'rspack.incremental.modulesHashes'),
        'chunkHashes': selected(record, 'rspack.incremental.chunksHashes'),
        'chunkAssets': selected(record, 'rspack.incremental.chunkAsset'),
        'moduleHashMs': timer(record, 'create module hashes'),
        'chunkHashMs': timer(record, 'hashing'),
        'chunkAssetMs': timer(record, 'create chunk assets'),
        'rebuildChunkGraphMs': timer(record, 'rebuild chunk graph'),
    }

for split in [0, 1]:
    samples = {base: [], fix: []}
    for pair in range(1, 6):
        members = {}
        for variant in [base, fix]:
            data = json.loads((root / f'{split}-{pair}-{variant}.json').read_text())
            members[variant] = data
            assert len(data['records']) in [3, 21]
            edits = [metrics(r) for r in data['records'][1:] if 'revert' not in r['label']]
            item = {'pair': pair, **{key: statistics.mean(x[key] for x in edits) for key in edits[0]},
                    'peakRss': data['peakRss'], 'steadyEndRss': data['steadyEndRss'], 'endRss': data['endRss'],
                    'maxDoneRss': max(r['rss'] for r in data['records'][1:]),
                    'medianDoneRss': statistics.median(r['rss'] for r in data['records'][1:])}
            if 'postGc' in data['records'][1]:
                item.update({'maxPostGcRss': max(r['postGc']['rss'] for r in data['records'][1:]),
                             'medianPostGcRss': statistics.median(r['postGc']['rss'] for r in data['records'][1:]),
                             'endRssAnon': data['end']['rssAnon']})
            samples[variant].append(item)
        for a, b in zip(members[base]['records'], members[fix]['records']):
            assert a['label'] == b['label']
            assert a['outputs'] == b['outputs'], f'Byte parity failed: split={split} pair={pair} label={a["label"]}'
            parity += 1
        for variant in [base, fix]:
            records = members[variant]['records']
            for record in records[1:]:
                if 'revert' in record['label']:
                    assert record['outputs'] == records[0]['outputs']
        assert samples[fix][-1]['rebuildChunkGraphMs'] == 0
    medians = {variant: {key: statistics.median(x[key] for x in items) for key in items[0] if key != 'pair'} for variant, items in samples.items()}
    saving = {key: medians[base][key] - medians[fix][key] for key in medians[base]}
    paired = {key: statistics.median(a[key] - b[key] for a, b in zip(samples[base], samples[fix])) for key in medians[base]}
    rows.append({'split': bool(split), 'samples': samples, 'medians': medians, 'medianDifferences': saving, 'pairedMedianDifferences': paired})
summary = {'base': base, 'fix': fix, 'pairedN': 5, 'parityBuilds': parity, 'rows': rows}
(root / f'summary-{base}-{fix}.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
