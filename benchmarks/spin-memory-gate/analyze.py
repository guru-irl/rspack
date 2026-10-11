"""Fail-closed paired summary of public synthetic measurements."""
import json
import math
import statistics as st
import sys
from pathlib import Path


def summarize(data):
    def check(ok, message):
        if not ok:
            raise ValueError(message)

    check(data.get('complete') is True, 'incomplete run')
    check(data.get('fixtureModules') == 60000, 'wrong fixture cardinality')
    records = data['records']
    check(len(records) == 44, 'expected 4 warmups plus 40 launches')
    check([r['arm'] for r in records[:4]] == ['OFF', 'SPIN', 'AA1', 'AA2'], 'warmup identities')
    expected = []
    for pair in range(1, 11):
        spin = [(pair, 'spin', a) for a in (['OFF', 'SPIN'] if pair % 2 else ['SPIN', 'OFF'])]
        aa = [(pair, 'aa', a) for a in (['AA1', 'AA2'] if pair % 2 else ['AA2', 'AA1'])]
        expected += spin + aa if pair % 2 else aa + spin
    check([(r['pair'], r['family'], r['arm']) for r in records[4:]] == expected, 'pair schedule')
    platform = records[0]['sample']['host']['platform']
    host = records[0]['sample']['host']
    for index, r in enumerate(records):
        s = r['sample']
        check(r['index'] == index and r['warmup'] == (index < 4), 'launch index/warmup')
        check(s['success'] and not s.get('error'), 'failed launch')
        check(s['host'] == host, 'host changed')
        check(s['environment']['spinRounds'] == ('2048' if r['arm'] == 'SPIN' else None), 'spin rounds contamination')
        check(s['environment']['spinMode'] == ('yield' if r['arm'] == 'SPIN' else None), 'spin mode contamination')
        check(len(s['builds']) == 7 and [b['phase'] for b in s['builds']] == ['cold'] + [f'edit{i}' for i in range(1, 7)], 'build count/phase')
        check(len(s['idleSamples']) == 20 and s['idleSamples'][-1]['idleMs'] >= 10000, 'settling schedule')
        times = [x['idleMs'] for x in s['idleSamples']]
        check(all(b > a for a, b in zip([0] + times[:-1], times)), 'idle sample order')
        check(abs(s['steadyRssMiB'] - st.median(x['rssMiB'] for x in s['idleSamples'][-5:])) < 1e-8, 'steady median')
        if platform == 'linux':
            check(abs(s['steadyRssAnonMiB'] - st.median(x['rssAnonMiB'] for x in s['idleSamples'][-5:])) < 1e-8, 'anon median')
        check(isinstance(s['peakRssMiB'], (int, float)) and math.isfinite(s['peakRssMiB']) and s['peakRssMiB'] > 0, 'unsupported maxrss')
        check(all(s['peakRssMiB'] >= b['peakRssMiB'] for b in s['builds']), 'peak not lifetime')
    metrics = {
        'peak RSS MiB': (lambda s: s['peakRssMiB'], True),
        'steady RSS MiB': (lambda s: s['steadyRssMiB'], True),
        'edit RSS median MiB': (lambda s: st.median(b['rssMiB'] for b in s['builds'][1:]), True),
        'cold wall ms': (lambda s: s['builds'][0]['wallMs'], False),
        'edit wall median ms': (lambda s: st.median(b['wallMs'] for b in s['builds'][1:]), False),
        'process CPU seconds': (lambda s: s['cpuSeconds'], False),
        'edit CPU median seconds': (lambda s: st.median(b['cpuSeconds'] for b in s['builds'][1:]), False),
        'cold cache groups ms': (lambda s: s['builds'][0]['cacheGroupsMs'], False),
        'edit cache groups median ms': (lambda s: st.median(b['cacheGroupsMs'] for b in s['builds'][1:]), False),
    }
    for i in range(1, 7):
        metrics[f'edit{i} RSS MiB'] = (lambda s, i=i: s['builds'][i]['rssMiB'], True)
        for label, key in [('wall ms', 'wallMs'), ('CPU seconds', 'cpuSeconds'), ('cache groups ms', 'cacheGroupsMs')]:
            metrics[f'edit{i} {label}'] = (lambda s, i=i, key=key: s['builds'][i][key], False)
    if platform == 'linux':
        metrics['steady RssAnon MiB'] = (lambda s: s['steadyRssAnonMiB'], True)
        metrics['edit RssAnon median MiB'] = (lambda s: st.median(b['rssAnonMiB'] for b in s['builds'][1:]), True)
        for i in range(1, 7):
            metrics[f'edit{i} RssAnon MiB'] = (lambda s, i=i: s['builds'][i]['rssAnonMiB'], True)
    arms = {a: [r for r in records[4:] if r['arm'] == a] for a in ['OFF', 'SPIN', 'AA1', 'AA2']}
    for a, rs in arms.items():
        check(len(rs) == 10 and [r['pair'] for r in rs] == list(range(1, 11)), 'incomplete pairs')
    def stats(xs):
        check(all(isinstance(x, (int, float)) and math.isfinite(x) and x >= 0 for x in xs), 'invalid metric')
        return {'median': st.median(xs), 'min': min(xs), 'max': max(xs)}
    result = {'host': host, 'branchSha': data['branchSha'], 'runId': data['runId'],
              'binding': data['binding'], 'bindingSha256': data['bindingSha256'], 'metrics': {}}
    neutral = True
    for label, (get, memory) in metrics.items():
        values = {a: [get(r['sample']) for r in rs] for a, rs in arms.items()}
        absolute = {a: stats(xs) for a, xs in values.items()}
        spin = [b - a for a, b in zip(values['OFF'], values['SPIN'])]
        aa = [b - a for a, b in zip(values['AA1'], values['AA2'])]
        signed_stats = lambda xs: {'median': st.median(xs), 'min': min(xs), 'max': max(xs)}
        tails = sum(x > max(aa) for x in spin)
        # Lower memory outside the signed lower bound is not a regression.
        within = st.median(spin) <= max(aa) and tails == 0
        if memory and not within:
            neutral = False
        result['metrics'][label] = {'absolute': absolute, 'spinDelta': signed_stats(spin),
            'aaDelta': signed_stats(aa), 'tails': tails if memory else None, 'memory': memory,
            'spinDeltas': spin, 'aaDeltas': aa}
    result['verdict'] = 'memory neutral (within A/A upper band, no excess tails)' if neutral else 'not memory neutral'
    return result


def markdown(result):
    h = result['host']
    lines = [f"## {h['platform']} ({h['arch']})", '',
        f"Run `{result['runId']}`, SHA `{result['branchSha']}`. {h['cpuCount']} logical cores, {h['availableParallelism']} available; {h['cpuModel']}; OS {h['release']}; Node {h['node']}, libuv {h['uv']}.", '',
        f"Binding `{result['binding']}`, SHA-256 `{result['bindingSha256']}`.", '',
        '| Metric | OFF | SPIN | A/A first OFF | A/A second OFF | SPIN − OFF | A/A second − first | Tails > A/A max |',
        '|---|---:|---:|---:|---:|---:|---:|---:|']
    fmt = lambda d: f"{d['median']:.3f} [{d['min']:.3f}, {d['max']:.3f}]"
    for name, m in result['metrics'].items():
        lines.append('| ' + ' | '.join([name] + [fmt(m['absolute'][a]) for a in ['OFF','SPIN','AA1','AA2']] +
            [fmt(m['spinDelta']), fmt(m['aaDelta']), f"{m['tails']}/10" if m['memory'] else 'n/a']) + ' |')
    lines += ['', f"**Verdict: {result['verdict']}.**", '', 'All cells are median [minimum, maximum]. Signed paired differences, not differences between arm medians. Per-edit memory gates are evaluated individually.', '']
    return '\n'.join(lines)

if __name__ == '__main__':
    data = json.loads(Path(sys.argv[1]).read_text())
    result = summarize(data)
    dest = Path(sys.argv[2])
    dest.with_suffix('.json').write_text(json.dumps(result, indent=2) + '\n')
    dest.with_suffix('.md').write_text(markdown(result))
    print(result['verdict'])
