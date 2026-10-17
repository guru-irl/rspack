from collections import Counter
from fractions import Fraction
import statistics


def signed_rank_p(differences):
    values = sorted((abs(x), x > 0) for x in differences if x != 0)
    if not values:
        return Fraction(1)
    ranks = []
    positive = 0
    i = 0
    while i < len(values):
        j = i + 1
        while j < len(values) and values[j][0] == values[i][0]:
            j += 1
        rank2 = i + 1 + j
        ranks.extend([rank2] * (j - i))
        positive += rank2 * sum(sign for _, sign in values[i:j])
        i = j
    distribution = Counter({0: 1})
    for rank in ranks:
        updated = distribution.copy()
        for total, count in distribution.items():
            updated[total + rank] += count
        distribution = updated
    observed = min(positive, sum(ranks) - positive)
    tail = sum(count for total, count in distribution.items() if total <= observed)
    return min(Fraction(1), Fraction(2 * tail, 1 << len(ranks)))


def paired_location(base, pr):
    delta = [Fraction(str(p)) - Fraction(str(b)) for b, p in zip(base, pr)]
    walsh = sorted({(a + b) / 2 for i, a in enumerate(delta) for b in delta[i:]})
    all_walsh = [(a + b) / 2 for i, a in enumerate(delta) for b in delta[i:]]
    accepted = []
    boundaries = [None, *walsh, None]
    for low, high in zip(boundaries, boundaries[1:]):
        probe = (low + high) / 2 if low is not None and high is not None else high - 1 if low is None else low + 1
        if signed_rank_p([x - probe for x in delta]) > Fraction(1, 20):
            accepted.append((low, high))
    for point in walsh:
        if signed_rank_p([x - point for x in delta]) > Fraction(1, 20):
            accepted.append((point, point))
    if not accepted:
        raise ValueError('Empty exact confidence set')
    lower = None if any(a is None for a, _ in accepted) else min(a for a, _ in accepted)
    upper = None if any(b is None for _, b in accepted) else max(b for _, b in accepted)
    return dict(
        hodgesLehmann=float(statistics.median(all_walsh)),
        exact95=[float(lower) if lower is not None else None, float(upper) if upper is not None else None],
        exactPAtZero=float(signed_rank_p(delta)),
        exactMethod='Two-sided exact Wilcoxon signed-rank inversion; doubled midranks, all sign assignments, zeros excluded; confidence-set hull closed conservatively at Walsh breakpoints',
    )
