import collections
import json
import pathlib
import re
import sys


def cpu(profile_path, metrics_path):
    p = json.load(open(profile_path))
    m = json.load(open(metrics_path))
    nodes = {n['id']: n for n in p['nodes']}
    t = p['startTime']
    totals = collections.Counter()
    make = collections.Counter()
    program_times = []
    loader_times = []
    for node_id, delta in zip(p['samples'], p['timeDeltas']):
        t += delta
        node = nodes[node_id]
        name = node['callFrame']['functionName']
        if m['marks']['buildStart'] * 1e6 <= t <= m['marks']['buildEnd'] * 1e6:
            totals[name] += delta
        if m['marks']['makeStart'] * 1e6 <= t <= m['marks']['makeEnd'] * 1e6:
            make[name] += delta
            if name == '(program)':
                program_times.append(t)
            if 'loader' in node['callFrame'].get('url', '').lower() or 'loader' in name.lower():
                loader_times.append(t)
    total = sum(totals.values())
    make_total = sum(make.values())
    nearest = []
    import bisect
    for t in program_times:
        i = bisect.bisect_left(loader_times, t)
        candidates = loader_times[max(0, i - 1):i + 1]
        if candidates:
            nearest.append(min(abs(t - v) for v in candidates))
    result = {'buildSampleUs': total, 'buildProgramUs': totals['(program)'],
              'buildProgramPercent': 100 * totals['(program)'] / max(1, total),
              'buildGcUs': totals['(garbage collector)'],
              'makeSampleUs': make_total, 'makeProgramUs': make['(program)'],
              'makeProgramPercent': 100 * make['(program)'] / max(1, make_total),
              'makeGcUs': make['(garbage collector)'],
              'programSamplesWithin5msOfLoader': sum(v <= 5000 for v in nearest),
              'programSamples': len(program_times),
              'topBuildSelfUs': totals.most_common(25), 'topMakeSelfUs': make.most_common(25)}
    pathlib.Path(metrics_path).with_name('validation-summary.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    if total < m['buildMs'] * 500:
        raise SystemExit('CPU-profile clocks do not cover the build')
    if result['makeProgramPercent'] < 10:
        raise SystemExit('Program share is too small; adjust fixture before native recording')


def js_frame(symbol, dso):
    return ('jitted-' in dso or 'jit-' in dso or
            bool(re.match(r'^(?:JS|LazyCompile|Function|Script|Builtin|BytecodeHandler):', symbol)) or
            'Builtin_' in symbol or 'Builtins_' in symbol)


def category(frames):
    syms = [f[0] for f in frames]
    joined = '\n'.join(syms)
    leaf = syms[0] if syms else '[unknown]'
    if re.search(r'CollectGarbage|Scaveng|MarkCompact|GarbageCollect|Sweeper|MinorGC|MajorGC|Evacuate|Heap::Collect|Heap::PerformGarbage', joined, re.I):
        return 'GC'
    if re.search(r'malloc|calloc|realloc|free\b|mi_|memcpy|memmove|memset|AllocateRaw|MemoryAllocator', leaf):
        return 'allocator / memory movement'
    for sym in syms:
        if re.search(r'napi_|NapiValue|napi::|napi_rs|napi::bindgen', sym):
            if re.search(r'string|String|utf8|utf16|Utf8|Utf16', sym):
                return 'N-API: strings'
            if re.search(r'buffer|Buffer|typedarray|arraybuffer', sym):
                return 'N-API: buffers'
            if re.search(r'array|Array|Vec<', sym):
                return 'N-API: arrays'
            if re.search(r'object|Object|property|Property|class|Class|instance|Instance|wrap|unwrap', sym):
                return 'N-API: objects / classes'
            if re.search(r'threadsafe|Threadsafe|ThreadSafe', sym):
                continue
            return 'N-API: other conversions / operations'
    if re.search(r'rspack_binding_api|rspack_napi|rspack_node', joined):
        return 'Rspack binding symbols'
    if re.search(r'ThreadSafeFunction|ThreadsafeFunction|threadsafe_function|uv_|node::Environment::Run|node::SpinEventLoop', joined):
        return 'ThreadsafeFunction / libuv'
    if re.search(r'v8::|Builtins_|Builtin_|BytecodeHandler|RegExp|regexp|Compile|IC::', joined):
        return 'V8 runtime / compile / IC / regexp'
    if re.search(r'malloc|calloc|realloc|mi_|memcpy|memmove|memset', joined):
        return 'allocator / memory movement'
    return 'other / unresolved'


def samples(path):
    frames = []
    timestamp = None
    for line in open(path, errors='replace'):
        match = re.search(r'\s(\d+\.\d+):\s', line)
        if match and not line[0].isspace():
            if timestamp is not None:
                yield timestamp, frames
            timestamp = float(match.group(1))
            frames = []
            continue
        match = re.match(r'\s*[0-9a-f]+\s+(.+)\s+\((.+)\)\s*$', line)
        if match:
            frames.append((match.group(1), match.group(2)))
    if timestamp is not None:
        yield timestamp, frames


def native(root):
    results = []
    for directory in sorted(pathlib.Path(root).glob('repeat-*')):
        m = json.load(open(directory / 'metrics.json'))
        groups = {}
        for phase in ['build', 'make']:
            for side in ['no-js-frame', 'under-js-frame']:
                groups[(phase, side)] = {'buckets': collections.Counter(), 'self': collections.Counter(), 'inclusive': collections.Counter(), 'stacks': collections.Counter(), 'samples': 0, 'truncated': 0}
        all_count = 0
        for t, frames in samples(directory / 'perf.script'):
            all_count += 1
            has_js = any(js_frame(s, d) for s, d in frames)
            side = 'under-js-frame' if has_js else 'no-js-frame'
            native_frames = [(s, d) for s, d in frames if not js_frame(s, d)]
            for phase in ['build', 'make']:
                if not (m['marks'][phase + 'Start'] <= t <= m['marks'][phase + 'End']):
                    continue
                g = groups[(phase, side)]
                g['samples'] += 1
                g['truncated'] += len(frames) >= 120
                bucket = category(native_frames) if native_frames else 'JavaScript self'
                if frames and js_frame(*frames[0]):
                    bucket = 'JavaScript self'
                g['buckets'][bucket] += 1
                if frames:
                    g['self'][frames[0][0]] += 1
                    for s in set(s for s, d in native_frames):
                        g['inclusive'][s] += 1
                    g['stacks'][';'.join(s.replace(';', ':') for s, d in reversed(frames))] += 1
        output = {'repeat': directory.name, 'metrics': m, 'parsedSamples': all_count, 'groups': {}}
        for (phase, side), g in groups.items():
            (directory / f'{phase}-{side}.folded').write_text(''.join(f'{s} {count}\n' for s, count in g['stacks'].items()))
            output['groups'][phase + '/' + side] = {'samples': g['samples'], 'truncated': g['truncated'], 'buckets': dict(g['buckets']), 'topSelf': g['self'].most_common(40), 'topInclusive': g['inclusive'].most_common(40), 'topStacks': g['stacks'].most_common(15)}
        (directory / 'attribution.json').write_text(json.dumps(output, indent=2))
        results.append(output)
        compact = {'repeat': directory.name, 'parsedSamples': all_count, 'buildMs': m['buildMs'], 'makeMs': m['makeMs'], 'mainCpuMs': m['mainCpuMs'], 'groups': {k: {'samples': v['samples'], 'buckets': v['buckets'], 'topSelf': v['topSelf'][:8], 'topInclusive': v['topInclusive'][:8]} for k, v in output['groups'].items()}}
        print(json.dumps(compact, indent=2))
    (pathlib.Path(root) / 'native-summary.json').write_text(json.dumps(results, indent=2))


if sys.argv[1] == 'cpu':
    cpu(*sys.argv[2:])
elif sys.argv[1] == 'native':
    native(sys.argv[2])
