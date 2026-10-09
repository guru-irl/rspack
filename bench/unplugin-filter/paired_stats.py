import itertools
import statistics

def paired(a, b):
    deltas = [y - x for x, y in zip(a, b)]
    assert len(a) == len(b) == 5
    values = sorted((abs(d), d > 0) for d in deltas if d != 0)
    ranks = []
    i = 0
    while i < len(values):
        j = i + 1
        while j < len(values) and values[j][0] == values[i][0]:
            j += 1
        rank = ((i + 1) + j) / 2
        ranks.extend((rank, values[k][1]) for k in range(i, j))
        i = j
    observed = sum(rank for rank, positive in ranks if positive)
    total = sum(rank for rank, _ in ranks)
    distance = abs(observed - total / 2)
    extreme = sum(abs(sum(rank for (rank, _), positive in zip(ranks, signs) if positive) - total / 2) >= distance for signs in itertools.product([False, True], repeat=len(ranks)))
    return {'median': statistics.median(deltas), 'p': extreme / 2 ** len(ranks), 'negative': sum(d < 0 for d in deltas), 'zero': sum(d == 0 for d in deltas), 'positive': sum(d > 0 for d in deltas), 'deltas': deltas}
