import difflib
import pathlib
import re

root = pathlib.Path.cwd()
built = root / 'source-results/source-dist'
patched = root / 'variants/U2r2/package/dist'

def region(path, name):
    text = path.read_text()
    a = text.index('//#region ' + name)
    b = text.index('//#endregion', a)
    text = text[a:b]
    text = re.sub(r'/\*.*?\*/|//[^\n]*', '', text, flags=re.S)
    return re.sub(r'\s+', '', text).replace('process$1', 'process')

pairs = [(next(built.glob('webpack-like-*.mjs')), next(patched.glob('webpack-like-*.mjs')), 'src/utils/webpack-like.ts')]
for adapter in ['rspack', 'webpack']:
    pairs.append((built / 'index.mjs', patched / 'index.mjs', f'src/{adapter}/index.ts'))
    for kind in ['load', 'transform']:
        pairs.append((built / f'{adapter}/loaders/{kind}.mjs', patched / f'{adapter}/loaders/{kind}.mjs', f'src/{adapter}/loaders/{kind}.ts'))
for left, right, name in pairs:
    a, b = region(left, name), region(right, name)
    if a != b:
        (root / 'source-results/dist-source-mismatch.txt').write_text('\n'.join(difflib.ndiff([a], [b])))
        raise AssertionError(f'Published patch differs from built source: {name}')
print('All seven changed implementation regions match production-built source')
