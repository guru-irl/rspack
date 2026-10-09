import base64
import difflib
import hashlib
import json
import pathlib
import subprocess
import tarfile
import urllib.request

root = pathlib.Path.cwd()
out = root / 'source-results'
out.mkdir(exist_ok=True)

def replace(text, old, new, count=1):
    assert text.count(old) == count, (old, text.count(old), count)
    return text.replace(old, new)

for version in ['3.4.0', '3.3.0']:
    prior = json.loads((root / f'unplugin-{version}-u2-manifest-v1.json').read_text())
    patch = root / f'unplugin-{version}-dist-u2-v1.patch'
    assert hashlib.sha256(patch.read_bytes()).hexdigest() == prior['patch_sha256']
    data = urllib.request.urlopen(prior['registry']['tarball']).read()
    assert hashlib.sha1(data).hexdigest() == prior['registry']['shasum']
    assert 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == prior['registry']['integrity']
    archive_path = root / f'regenerate-{version}.tgz'
    archive_path.write_bytes(data)
    dest = root / f'regenerate-{version}'
    dest.mkdir()
    with tarfile.open(archive_path) as archive:
        archive.extractall(dest, filter='data')
    package = dest / 'package'
    before = {p.relative_to(package).as_posix(): p.read_text() for p in package.rglob('*') if p.is_file()}
    for item in prior['files']:
        assert hashlib.sha256((package / item['path']).read_bytes()).hexdigest() == item['sha256_before']
    subprocess.run(['patch', '-p1', '-i', str(patch)], cwd=package, check=True)
    for item in prior['files']:
        assert hashlib.sha256((package / item['path']).read_bytes()).hexdigest() == item['sha256_after']
    helper = next((package / 'dist').glob('webpack-like-*.mjs'))
    text = helper.read_text()
    a, b = text.index('function createCachedIdFilter('), text.index('function transformUse(')
    text = text[:a] + '''function createCachedIdFilter(getHook) {
	let cached;
	return (id) => {
		const hook = getHook();
		const cwd = process.cwd();
		if (cached?.hook !== hook || cached.cwd !== cwd) cached = { hook, cwd, filter: normalizeObjectHook("load", hook).filter };
		return cached.filter(id);
	};
}
''' + text[b:]
    helper.write_text(text)
    for adapter in ['rspack', 'webpack']:
        load = package / f'dist/{adapter}/loaders/load.mjs'
        text = load.read_text()
        text = '\n'.join(line for line in text.split('\n') if not (line.startswith('import ') and 'normalizeObjectHook' in line))
        text = replace(text, 'const filters = new WeakMap();\n', '')
        a = text.index('\tconst hook = plugin.load;')
        b = text.index('\n\ttry {' if adapter == 'rspack' else '\n\tconst res =', a)
        text = text[:a] + '\tconst hook = plugin.load;\n\tconst handler = typeof hook === "function" ? hook : hook.handler;' + text[b:]
        load.write_text(text)
    index = package / 'dist/index.mjs'
    text = index.read_text()
    text = replace(text, 'createCachedIdFilter(plugin.load)', 'createCachedIdFilter(() => plugin.load)', 2)
    text = replace(text, 'createCachedIdFilter(plugin.transform)', 'createCachedIdFilter(() => plugin.transform)', 2)
    for adapter in ['rspack', 'webpack']:
        a = text.index(f'//#region src/{adapter}/index.ts')
        b = text.index('//#endregion', a)
        section = text[a:b]
        indent = '\t\t\t' if adapter == 'rspack' else '\t\t\t\t\t'
        section = replace(section, 'if (plugin.resolveId) {', 'if (plugin.resolveId) {\n' + indent + 'let cachedResolveId;')
        ind = '\t\t\t\t\t' if adapter == 'rspack' else '\t\t\t\t\t\t\t'
        replacement = '''const hook = plugin.resolveId;
const cwd = process.cwd();
let handler;
if (cachedResolveId?.hook === hook && cachedResolveId.cwd === cwd) handler = typeof hook === "function" ? hook : hook.handler;
else {
	const normalized = normalizeObjectHook("resolveId", hook);
	handler = normalized.handler;
	cachedResolveId = { hook, cwd, filter: normalized.filter };
}
const { filter } = cachedResolveId;'''
        section = replace(section, 'const { handler, filter } = normalizeObjectHook("resolveId", plugin.resolveId);', ('\n' + ind).join(replacement.splitlines()))
        text = text[:a] + section + text[b:]
    index.write_text(text)
    # Untouched adapters and source regions remain byte-identical to the previous dist.
    changed = sorted(p.relative_to(package).as_posix() for p in package.rglob('*') if p.is_file() and p.read_text() != before[p.relative_to(package).as_posix()])
    assert changed == sorted(item['path'] for item in prior['files']), changed
    diff = ''.join('diff --git a/' + name + ' b/' + name + '\n' + ''.join(difflib.unified_diff(before[name].splitlines(True), (package / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name)) for name in changed)
    target = out / f'unplugin-{version}-dist-u2.patch'
    target.write_text(diff)
    manifest = {**prior, 'patch_sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'files': [{'path': name, 'sha256_before': hashlib.sha256(before[name].encode()).hexdigest(), 'sha256_after': hashlib.sha256((package / name).read_bytes()).hexdigest()} for name in changed], 'semantics': 'Lazy rule and resolveId filters keyed by current hook identity and cwd; transform-loader WeakMaps keyed by hook with cwd invalidation. Load loaders read handlers directly without filter caches. Handlers read fresh. In-place filter mutation after first use is a snapshot until hook replacement or cwd change.', 'apply_command': f'cd <extracted-package> && patch -p1 -i <absolute-path>/unplugin-{version}-dist-u2.patch', 'source_base': 'f2acf00e1f8e4fbeaa28f6660545c70c43cb2d73'}
    (out / f'unplugin-{version}-u2-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(version, manifest['patch_sha256'])
