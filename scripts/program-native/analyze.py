import bisect
import collections
import json
import pathlib
import re
import statistics
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
    bounded = 0
    for t in program_times:
        i = bisect.bisect_left(loader_times, t)
        candidates = loader_times[max(0, i - 1):i + 1]
        if candidates:
            nearest.append(min(abs(t - v) for v in candidates))
        if 0 < i < len(loader_times) and t - loader_times[i - 1] <= 20000 and loader_times[i] - t <= 20000:
            bounded += 1
    result = {'buildSampleUs': total, 'buildProgramUs': totals['(program)'],
              'buildProgramPercent': 100 * totals['(program)'] / max(1, total),
              'buildGcUs': totals['(garbage collector)'],
              'makeSampleUs': make_total, 'makeProgramUs': make['(program)'],
              'makeProgramPercent': 100 * make['(program)'] / max(1, make_total),
              'makeGcUs': make['(garbage collector)'],
              'programSamplesWithin5msOfLoader': sum(v <= 5000 for v in nearest),
              'programSamplesBoundedByLoaderWithin20ms': bounded,
              'programSamples': len(program_times),
              'topBuildSelfUs': totals.most_common(25), 'topMakeSelfUs': make.most_common(25)}
    pathlib.Path(metrics_path).with_name('validation-summary.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    if total < m['buildMs'] * 500:
        raise SystemExit('CPU-profile clocks do not cover the build')
    if result['makeProgramPercent'] < 10:
        raise SystemExit('Program share is too small; adjust fixture before native recording')


def js_frame(symbol, dso):
    if re.search(r'^(?:Builtin|BytecodeHandler|RegExp):|^Builtins?_|^v8::', symbol):
        return False
    if re.match(r'^(?:JS|LazyCompile|Function|Script):', symbol):
        return True
    return ('jitted-' in dso or 'jit-' in dso) and bool(re.search(r'\.(?:m?js|cjs|ts):\d+', symbol))


GC = r'CollectGarbage|Scaveng|MarkCompact|GarbageCollect|Sweeper|MinorGC|MajorGC|Evacuate|Heap::Collect|Heap::PerformGarbage'
MEMORY = r'malloc|calloc|realloc|free\b|mi_|memcpy|memmove|memset|AllocateRaw|MemoryAllocator'
NAPI = r'\bnapi_(?!call_threadsafe|create_threadsafe|release_threadsafe)|::(?:to_napi_value|from_napi_value)|napi::bindgen_runtime::js_values'
OPERATIONS = {
    'module materialization': r'NormalModule::into_module_instance|define_module_properties|define_shared_properties|::new_inherited',
    'ModuleObject to-JS including lookup': r'ModuleObject.*to_napi_value',
    'JsLoaderContext to-JS': r'JsLoaderContext.*to_napi_value',
    'JsLoaderContext from-JS': r'JsLoaderContext.*from_napi_value',
    'JsLoaderItem conversion': r'JsLoaderItem.*(?:to_napi_value|from_napi_value)',
    'N-API object property operations': r'\bnapi_(?:define_properties|set_named_property|get_named_property|has_named_property|create_object|new_instance|wrap|unwrap)',
    'N-API string operations': r'\bnapi_(?:create_string|get_value_string)|napi::.*(?:string|String).*napi_value',
    'N-API buffer operations': r'\bnapi_.*(?:buffer|typedarray)|napi::.*Buffer.*napi_value',
    'N-API array operations': r'\bnapi_(?:create_array|get_array_length|get_element|set_element)',
    'TSFN dispatch inclusive of work': r'ThreadSafeFunction::(?:Dispatch|DispatchOne)|napi::threadsafe_function::call_js_cb',
    'get_loader_runner': r'get_loader_runner|JsLoaderRunnerGetter',
    'UTF-8 validation': r'validate_utf8|run_utf8_validation|simdutf8|from_utf8',
}


def category(frames):
    syms = [f[0] for f in frames]
    joined = '\n'.join(syms)
    leaf = syms[0] if syms else '[unknown]'
    if re.search(GC, joined, re.I):
        return 'GC'
    if re.search(MEMORY, leaf):
        return 'allocator / memory movement'
    for sym in syms:
        if re.search(NAPI, sym):
            if re.search(r'string|String|utf8|utf16|Utf8|Utf16', sym):
                return 'N-API: strings'
            if re.search(r'buffer|Buffer|typedarray|arraybuffer', sym):
                return 'N-API: buffers'
            if re.search(r'array|Array|Vec<', sym):
                return 'N-API: arrays'
            if re.search(r'object|Object|property|Property|class|Class|instance|Instance|wrap|unwrap', sym):
                return 'N-API: objects / classes'
            return 'N-API: other operations'
    if re.search(r'rspack_binding_api|rspack_napi|rspack_node', leaf):
        return 'Rspack binding symbols'
    if re.search(r'ThreadSafeFunction|ThreadsafeFunction|threadsafe_function|uv_|node::Environment::Run|node::SpinEventLoop', leaf):
        return 'ThreadsafeFunction / libuv'
    if re.search(r'v8::|Builtins?_|Builtin:|BytecodeHandler|RegExp|regexp|Compile|IC::', joined):
        return 'V8 runtime / compile / IC / regexp'
    if re.search(MEMORY, joined):
        return 'allocator / memory movement'
    if re.search(r'rspack_binding_api|rspack_napi|rspack_node', joined):
        return 'Rspack binding symbols'
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
            symbol = re.sub(r'\+0x[0-9a-f]+$', '', match.group(1))
            frames.append((symbol, match.group(2)))
    if timestamp is not None:
        yield timestamp, frames


def native(root):
    results = []
    for directory in sorted(pathlib.Path(root).glob('repeat-*')):
        m = json.load(open(directory / 'metrics.json'))
        groups = {}
        for phase in ['build', 'make']:
            for side in ['no-js-frame', 'under-js-frame']:
                groups[(phase, side)] = {'buckets': collections.Counter(), 'self': collections.Counter(), 'inclusive': collections.Counter(), 'operations': collections.Counter(), 'stacks': collections.Counter(), 'samples': 0, 'empty': 0, 'depth': collections.Counter()}
        all_count = 0
        for t, frames in samples(directory / 'perf.script'):
            all_count += 1
            first_js = next((i for i, (s, d) in enumerate(frames) if js_frame(s, d)), len(frames))
            side = 'under-js-frame' if first_js < len(frames) else 'no-js-frame'
            active_native = frames[:first_js]
            for phase in ['build', 'make']:
                if not (m['marks'][phase + 'Start'] <= t <= m['marks'][phase + 'End']):
                    continue
                g = groups[(phase, side)]
                g['samples'] += 1
                g['empty'] += not bool(frames)
                g['depth'][len(frames)] += 1
                bucket = category(active_native) if first_js else 'JavaScript self'
                g['buckets'][bucket] += 1
                if frames:
                    if first_js:
                        g['self'][frames[0][0]] += 1
                    for s in set(s for s, d in active_native):
                        g['inclusive'][s] += 1
                    active_symbols = '\n'.join(s for s, d in active_native)
                    for operation, pattern in OPERATIONS.items():
                        if re.search(pattern, active_symbols):
                            g['operations'][operation] += 1
                    g['stacks'][';'.join(s.replace(';', ':') for s, d in reversed(frames))] += 1
        if all_count < 100:
            raise SystemExit(f'Insufficient parsed samples in {directory}: {all_count}')
        output = {'repeat': directory.name, 'metrics': m, 'parsedSamples': all_count, 'groups': {}}
        for (phase, side), g in groups.items():
            (directory / f'{phase}-{side}.folded').write_text(''.join(f'{s} {count}\n' for s, count in g['stacks'].items()))
            output['groups'][phase + '/' + side] = {'samples': g['samples'], 'empty': g['empty'], 'depth': dict(g['depth']), 'buckets': dict(g['buckets']), 'operations': dict(g['operations']), 'topSelf': g['self'].most_common(60), 'topInclusive': g['inclusive'].most_common(60), 'topStacks': g['stacks'].most_common(25)}
        (directory / 'attribution.json').write_text(json.dumps(output, indent=2))
        results.append(output)
        compact = {'repeat': directory.name, 'parsedSamples': all_count, 'buildMs': m['buildMs'], 'makeMs': m['makeMs'], 'mainCpuMs': m['mainCpuMs'], 'groups': {k: {'samples': v['samples'], 'empty': v['empty'], 'buckets': v['buckets'], 'operations': v['operations'], 'topSelf': v['topSelf'][:8], 'topInclusive': v['topInclusive'][:8]} for k, v in output['groups'].items()}}
        print(json.dumps(compact, indent=2))
    (pathlib.Path(root) / 'native-summary.json').write_text(json.dumps(results, indent=2))
    if len(results) != 3:
        raise SystemExit(f'Expected three repeats, found {len(results)}')
    print('MEDIANS')
    for metric in ['buildMs', 'makeMs', 'mainCpuMs', 'makeGcMs', 'peakRss', 'steadyRss']:
        print(metric, statistics.median(r['metrics'][metric] for r in results))
    for phase in ['build', 'make']:
        print('PHASE', phase)
        for side in ['no-js-frame', 'under-js-frame']:
            key = phase + '/' + side
            buckets = sorted(set(k for r in results for k in r['groups'][key]['buckets']))
            for bucket in buckets:
                percentages = []
                milliseconds = []
                for r in results:
                    denominator = sum(r['groups'][phase + '/' + s]['samples'] for s in ['no-js-frame', 'under-js-frame'])
                    count = r['groups'][key]['buckets'].get(bucket, 0)
                    percentages.append(100 * count / max(1, denominator))
                    build_denominator = sum(r['groups']['build/' + s]['samples'] for s in ['no-js-frame', 'under-js-frame'])
                    milliseconds.append(r['metrics']['mainCpuMs'] * count / max(1, build_denominator))
                print(side, bucket, 'percent', [round(v, 3) for v in percentages], 'median-ms', round(statistics.median(milliseconds), 3))


if sys.argv[1] == 'cpu':
    cpu(*sys.argv[2:])
elif sys.argv[1] == 'native':
    native(sys.argv[2])
