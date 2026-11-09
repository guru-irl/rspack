import collections
import datetime
import fractions
import hashlib
import json
import math
import re
from pathlib import Path


ROOT = Path('.audit')
TESTS = [
    'rename', 'replace-new-immediate', 'replace-same-immediate',
    'replace-new-observed', 'replace-same-observed', 'roundtrip-immediate',
    'roundtrip-observed', 'replace-same-immediate-future',
    'roundtrip-immediate-future', 'recreate-same-immediate-future', 'directory',
]
SPECS = {
    'candidate': (
        '80522e0611ed6f4b6260af91a3df8b99f7badf2c',
        '823fc9f0488ccb5c4cb82c234220169eb68ea84d',
    ),
    'main': (
        '1fb825ce951589c7cb39b51a0bb4c209960e97f6',
        'bb2bc70cb6385ad4133bcdff9cb3dcadf693e5d5',
    ),
}
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
NAME = re.compile(r'native-watcher-rename-aggregation/([^: >]+): should aggregate ')
SKIPPED = {'skip', 'todo', 'pending'}


def identities():
    found = {}
    for arm, (commit, tree) in SPECS.items():
        files = list((ROOT / 'bindings' / arm).glob('*.node'))
        assert len(files) == 1, (arm, files)
        digest = hashlib.sha256(files[0].read_bytes()).hexdigest()
        producer = ROOT / 'producer' / arm
        receipt = json.loads((producer / 'binding.json').read_text())
        source = (producer / 'source.txt').read_text().strip()
        assert source.startswith(f'{commit} {tree} '), (arm, source)
        assert digest == receipt['sha256'], (arm, digest, receipt['sha256'])
        found[arm] = {'sha': commit, 'tree': tree, 'sha256': digest, 'file': files[0].name}
        print('AUDIT_PRODUCER ' + json.dumps({'arm': arm, **found[arm]}))
    assert found['candidate']['sha256'] != found['main']['sha256']
    return found


def parse_events(text):
    starts, ends = [], []
    for line in ANSI.sub('', text).splitlines():
        fields = line.split(' | ')
        if len(fields) >= 3 and fields[1] == 'TEST_START':
            starts.append(fields[0])
        if len(fields) >= 4 and fields[1] == 'TEST_END':
            ends.append((fields[0], fields[3]))
    ignored = {name for name, status in ends if status in SKIPPED}
    active_starts = [name for name in starts if name not in ignored]
    active_ends = [(name, status) for name, status in ends if status not in SKIPPED]
    assert len(active_starts) == len(active_ends) == 11
    assert sorted(active_starts) == sorted(name for name, _ in active_ends)
    observed = {}
    for key, status in active_ends:
        match = NAME.search(key)
        assert match and status in {'pass', 'fail'}, (key, status)
        name = match.group(1)
        assert name not in observed, name
        observed[name] = status
    assert set(observed) == set(TESTS), observed
    assert ' | TEST_RUN_END | ' in text
    return observed


def check_proof(text, arm, digest):
    proofs = []
    for line in ANSI.sub('', text).splitlines():
        marker = 'BINDING_IDENTITY '
        if marker in line:
            proofs.append(json.loads(line.split(marker, 1)[1]))
    assert proofs, arm
    for proof in proofs:
        assert proof['sha256'] == digest, (arm, proof)
        assert proof['proof'] == 'dlopen', proof
        assert f'/bindings/{arm}/' in proof['binding'], proof
    return len(proofs)


def check_trial(row, event_text, log_text, found):
    observed = parse_events(event_text)
    failed = sorted(name for name, status in observed.items() if status == 'fail')
    assert row['started'] == 11
    assert row['passed'] == 11 - len(failed)
    assert row['failed'] == failed
    assert (row['exit'] == 0) == (len(failed) == 0)
    assert row['bindingSha256'] == found[row['arm']]['sha256']
    count = check_proof(log_text, row['arm'], found[row['arm']]['sha256'])
    return observed, count


def exact_fisher(a, n1, b, n2):
    total = a + b
    denom = math.comb(n1 + n2, total)
    def probability(x):
        return fractions.Fraction(math.comb(n1, x) * math.comb(n2, total - x), denom)
    observed = probability(a)
    return float(sum(
        (probability(x) for x in range(max(0, total - n2), min(n1, total) + 1)
         if probability(x) <= observed),
        fractions.Fraction(0),
    ))


def negative_control(fn):
    try:
        fn()
    except (AssertionError, ValueError, json.JSONDecodeError):
        return
    raise AssertionError('A deliberately corrupted receipt was accepted')


def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


def corrupt_rename_event(text, before, after):
    lines = text.splitlines(keepends=True)
    matches = [i for i, line in enumerate(lines)
               if 'native-watcher-rename-aggregation/rename: should aggregate ' in line and before in line]
    assert len(matches) == 1, matches
    lines[matches[0]] = lines[matches[0]].replace(before, after, 1)
    return ''.join(lines)


def main():
    found = identities()
    receipt_dir = ROOT / 'paired'
    rows = [json.loads(line) for line in (receipt_dir / 'trials.jsonl').read_text().splitlines()]
    reported = json.loads((receipt_dir / 'summary.json').read_text())
    assert len(rows) == 60
    assert len(list(receipt_dir.glob('trial-*-*.events.txt'))) == 60
    failed_runs = collections.Counter()
    failures = {arm: collections.Counter() for arm in SPECS}
    starts = collections.Counter()
    passes = collections.Counter()
    proof_counts = collections.Counter()
    failed_rounds = {arm: [] for arm in SPECS}
    previous_end = None
    for index, row in enumerate(rows):
        arm = 'candidate' if index % 2 == 0 else 'main'
        number = index // 2 + 1
        assert row['arm'] == arm and row['number'] == number and not row['diagnostic']
        start, end = timestamp(row['start']), timestamp(row['end'])
        assert start < end and (previous_end is None or previous_end <= start)
        previous_end = end
        label = f'trial-{number:02d}-{arm}'
        event_text = (receipt_dir / f'{label}.events.txt').read_text()
        log_text = (receipt_dir / f'{label}.log').read_text()
        observed, count = check_trial(row, event_text, log_text, found)
        starts[arm] += len(observed)
        passes[arm] += sum(status == 'pass' for status in observed.values())
        proof_counts[arm] += count
        for name, status in observed.items():
            if status == 'fail':
                failures[arm][name] += 1
        if row['failed']:
            failed_runs[arm] += 1
            failed_rounds[arm].append({'round': number, 'tests': row['failed']})
        if index == 0:
            broken_start = corrupt_rename_event(event_text, ' | TEST_START | ', ' | MISSING_START | ')
            negative_control(lambda: check_trial(row, broken_start, log_text, found))
            broken_result = corrupt_rename_event(event_text, ' | pass | ', ' | fail | ')
            negative_control(lambda: check_trial(row, broken_result, log_text, found))
            negative_control(lambda: check_proof(log_text, arm, '0' * 64))
    assert starts == {'candidate': 330, 'main': 330}
    for arm in SPECS:
        assert reported['arms'][arm]['runs'] == 30
        assert reported['arms'][arm]['runsWithFailure'] == failed_runs[arm]
        assert reported['arms'][arm]['testStarts'] == starts[arm]
        assert reported['arms'][arm]['testPasses'] == passes[arm]
        assert reported['arms'][arm]['testFailures'] == sum(failures[arm].values())
        for field in ('sha', 'tree', 'sha256'):
            assert reported['identities'][arm][field] == found[arm][field]
    run_p = exact_fisher(failed_runs['candidate'], 30, failed_runs['main'], 30)
    assert abs(reported['fisherRunP'] - run_p) < 1e-12
    per_test = []
    for name in TESTS:
        c, m = failures['candidate'][name], failures['main'][name]
        p = exact_fisher(c, 30, m, 30)
        declared = next(item for item in reported['perTest'] if item['name'] == name)
        assert (declared['candidateFailures'], declared['mainFailures']) == (c, m)
        assert abs(declared['fisherP'] - p) < 1e-12
        item = {'name': name, 'candidate': c, 'main': m, 'denominator': 30, 'fisherP': p}
        per_test.append(item)
        print('AUDIT_TEST ' + json.dumps(item))
    result = ('SAME' if failed_runs['candidate'] <= failed_runs['main'] else
              'CANDIDATE-WORSE' if run_p < 0.1 else 'INCONCLUSIVE')
    assert result == reported['result']
    evidence = {
        'result': result, 'runsPerArm': 30, 'runFailures': dict(failed_runs),
        'testStarts': dict(starts), 'testPasses': dict(passes),
        'testFailures': {arm: sum(failures[arm].values()) for arm in SPECS},
        'fisherRunP': run_p, 'bindingProofLines': dict(proof_counts),
        'identities': found, 'perTest': per_test, 'failedRounds': failed_rounds,
    }
    (ROOT / 'independent-summary.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print('AUDIT_CONTROLS rejected missing start, altered result and wrong binding hash')
    print('AUDIT_SUMMARY ' + json.dumps(evidence))
    print('RESULT: ' + result)


if __name__ == '__main__':
    main()
