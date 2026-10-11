import collections, json, pathlib, re, sys
results = pathlib.Path(sys.argv[1])
windows = []
begin = None
for line in (results / 'profile-memfs.log').read_text().splitlines():
    if line.startswith('STUDY_BEGIN '): begin = int(line.split()[1]) / 1e9
    if line.startswith('STUDY_END '):
        end = json.loads(line[len('STUDY_END '):])
        if end['edit'] > 0 and begin is not None: windows.append((begin, int(end['monoNs']) / 1e9))
self_counts = collections.Counter(); inclusive = collections.Counter(); groups = collections.Counter(); samples = 0
for block in sys.stdin.read().split('\n\n'):
    lines = block.splitlines()
    if not lines: continue
    match = re.search(r'\s(\d+\.\d+):', lines[0])
    if not match or not any(a <= float(match[1]) <= b for a, b in windows): continue
    frames = [re.sub(r'^\s*[a-f0-9]+\s+', '', line).strip() for line in lines[1:] if line.strip()]
    if not frames: continue
    samples += 1; self_counts[frames[0]] += 1
    for frame in set(frames): inclusive[frame] += 1
    stack = '\n'.join(frames)
    # Disjoint classification by outer context, then inner operation. Unclassified costs remain visible.
    if 'study_content' in stack: group = 'sourcesContent JSON escaping/writes'
    elif 'JsSourceToJs' in stack or 'get_asset_source' in stack: group = 'assetEmitted source conversion'
    elif 'NodeFileSystem' in stack and 'read_file' in stack: group = 'emit readback handoff/copy'
    elif 'NodeFileSystem' in stack and 'write' in stack: group = 'emit write handoff/copy'
    elif 'LinesOnlyMappingsEncoder' in stack or 'FullMappingsEncoder' in stack or 'encode_vlq' in stack: group = 'mappings VLQ encoding'
    elif 'CachedSourceChunks' in stack: group = 'module cached-map replay/retrieval'
    elif 'ConcatSourceChunks' in stack: group = 'concat stream stitching/indices'
    elif 'simd_json' in stack: group = 'other JSON assembly'
    elif 'emit_asset' in stack: group = 'other native emit'
    else: group = 'other watch work / JS / allocator'
    groups[group] += 1
(results / 'perf-watch-summary.json').write_text(json.dumps({'windows': windows, 'samples': samples, 'groups': groups, 'self': self_counts.most_common(100), 'inclusive': inclusive.most_common(150)}, indent=2))
