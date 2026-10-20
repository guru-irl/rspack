import sys
from pathlib import Path


def compare(left, right):
    assert left.is_dir() and right.is_dir(), 'Missing output directory'
    files = lambda root: sorted(p.relative_to(root) for p in root.rglob('*') if p.is_file())
    a, b = files(left), files(right)
    assert a and a == b, 'Missing, extra or empty output file set'
    for name in a:
        assert (left / name).read_bytes() == (right / name).read_bytes(), f'Output differs: {name}'


if sys.argv[1:] == ['--self-test']:
    root = Path('bench-data/comparison-self-test')
    left, right = root / 'left', root / 'right'
    left.mkdir(parents=True, exist_ok=True)
    right.mkdir(parents=True, exist_ok=True)
    (left / 'bundle.cjs').write_bytes(b'expected\n')
    (right / 'bundle.cjs').write_bytes(b'expected\n')
    compare(left, right)
    for mutation in ['bytes', 'missing', 'extra', 'directory']:
        (right / 'bundle.cjs').write_bytes(b'expected\n')
        if mutation == 'bytes':
            (right / 'bundle.cjs').write_bytes(b'changed!\n')
        elif mutation == 'missing':
            (right / 'bundle.cjs').unlink()
        elif mutation == 'extra':
            (right / 'extra.cjs').write_bytes(b'extra\n')
        try:
            compare(left, root / 'absent' if mutation == 'directory' else right)
        except AssertionError:
            print(f'Rejected {mutation} mismatch')
        else:
            raise AssertionError(f'Comparator accepted {mutation} mismatch')
        if (right / 'extra.cjs').exists():
            (right / 'extra.cjs').unlink()
    (right / 'bundle.cjs').write_bytes(b'expected\n')
    compare(left, right)
else:
    compare(Path(sys.argv[1]), Path(sys.argv[2]))
    print('Emitted file names and bytes match')
