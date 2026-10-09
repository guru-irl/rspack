import itertools
import json
from pathlib import Path
import statistics
import sys

ARMS = ['round3', 'round2', 'off']
FIELDS = [
    ('buildMs', 'Build ms', 1), ('makeMs', 'Make ms', 1), ('wallMs', 'Process wall ms', 1),
    ('userMs', 'User CPU ms', 1), ('systemMs', 'System CPU ms', 1),
    ('readRequests', 'Device read requests', 1), ('readMiB', 'Device read MiB', 1),
    ('rssAnonPeakKiB', 'Peak RssAnon MiB', 1/1024), ('rssAnonEndKiB', 'End RssAnon MiB', 1/1024),
    ('vmHwmKiB', 'VmHWM MiB', 1/1024), ('vmSwapPeakKiB', 'Peak VmSwap MiB', 1/1024),
]


def distribution(values):
    return f'{statistics.median(values):.3f} [{min(values):.3f}, {max(values):.3f}]'


def wilcoxon(differences):
    values = [value for value in differences if value != 0]
    if not values:
        return 1.0, 0
    ordered = sorted(range(len(values)), key=lambda index: abs(values[index]))
    ranks = [0.0] * len(values)
    first = 0
    while first < len(ordered):
        last = first + 1
        while last < len(ordered) and abs(values[ordered[last]]) == abs(values[ordered[first]]):
            last += 1
        rank = (first + 1 + last) / 2
        for index in ordered[first:last]:
            ranks[index] = rank
        first = last
    total = sum(ranks)
    plus = sum(rank for value, rank in zip(values, ranks) if value > 0)
    observed = min(plus, total - plus)
    outcomes = [sum(rank for rank, sign in zip(ranks, signs) if sign)
                for signs in itertools.product([False, True], repeat=len(values))]
    extreme = sum(min(value, total - value) <= observed for value in outcomes)
    return extreme / len(outcomes), len(values)


def validate(rows):
    if len(rows) != 45:
        raise ValueError(f'need 45 successful rows, got {len(rows)}')
    keys = {(row['delayMs'], row['round'], row['arm']) for row in rows}
    expected = set(itertools.product([0, 1, 3], range(1, 6), ARMS))
    if keys != expected:
        raise ValueError('missing or duplicate arm/round/delay')
    graphs = {row['modules'] for row in rows}
    if len(graphs) != 1 or not graphs <= {72061, 36061}:
        raise ValueError('invalid graph counts')
    for row in rows:
        if row['residencyPercent'] != 0 or row['counts'] != {'buildModule': 0, 'stillValidModule': row['modules']}:
            raise ValueError('invalid cold-page warm start')
        if row['arm'] == 'off' and row['prefetch']:
            raise ValueError('disabled prefetch logged')
        for field, _, _ in FIELDS:
            if not isinstance(row[field], (int, float)) or row[field] < 0:
                raise ValueError(f'invalid metric {field}')


def analyze(rows):
    validate(rows)
    print('# Fixed-latency warm-open comparison\n')
    print('All values are median [minimum, maximum], n=5 per arm and delay.\n')
    print('| Read delay ms | Arm | Build ms | Make ms | Wall ms | Peak RssAnon MiB | End RssAnon MiB | Read MiB |')
    print('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
    for delay in [0, 1, 3]:
        for arm in ARMS:
            group = [row for row in rows if row['delayMs'] == delay and row['arm'] == arm]
            metrics = [('buildMs', 1), ('makeMs', 1), ('wallMs', 1), ('rssAnonPeakKiB', 1/1024),
                       ('rssAnonEndKiB', 1/1024), ('readMiB', 1)]
            cells = [distribution([row[field] * scale for row in group]) for field, scale in metrics]
            print(f'| {delay} | {arm} | ' + ' | '.join(cells) + ' |')
    for delay in [0, 1, 3]:
        print(f'\n## {delay} ms added read delay\n')
        print('| Metric | Round 3 | Round 2 | Prefetch off |\n| --- | ---: | ---: | ---: |')
        for field, title, scale in FIELDS:
            cells = [distribution([row[field] * scale for row in rows if row['delayMs'] == delay and row['arm'] == arm]) for arm in ARMS]
            print(f'| {title} | ' + ' | '.join(cells) + ' |')
        print('\n### Paired differences\n')
        print('Round 3 minus comparator within the same round; negative means lower. Exact two-sided Wilcoxon signed-rank p, average ranks for ties, zero differences omitted. With five nonzero pairs the minimum possible p is 0.0625.\n')
        print('| Comparator | Metric | Difference | Wilcoxon p | Nonzero pairs |\n| --- | --- | ---: | ---: | ---: |')
        lookup = {(row['round'], row['arm']): row for row in rows if row['delayMs'] == delay}
        for comparator in ['round2', 'off']:
            for field, title, scale in FIELDS:
                diffs = [(lookup[rep, 'round3'][field] - lookup[rep, comparator][field]) * scale for rep in range(1, 6)]
                p, n = wilcoxon(diffs)
                print(f'| {comparator} | {title} | {distribution(diffs)} | {p:.4f} | {n} |')
        print('\n### Prefetch log\n')
        print('| Round | Arm | Files | Bytes | Log time ms |\n| ---: | --- | ---: | ---: | ---: |')
        for row in sorted([row for row in rows if row['delayMs'] == delay], key=lambda row: (row['round'], ARMS.index(row['arm']))):
            if row['prefetch']:
                for event in row['prefetch']:
                    print(f'| {row["round"]} | {row["arm"]} | {event["files"]} | {event["bytes"]} | {event["ms"]} |')
            else:
                print(f'| {row["round"]} | {row["arm"]} | absent | absent | absent |')


if __name__ == '__main__':
    analyze([json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()])
