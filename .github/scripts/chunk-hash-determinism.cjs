const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve('.hash-repro');
const fixture = path.join(root, 'fixture');
const evidence = path.join(root, 'evidence');
const packageRequire = require('node:module').createRequire(path.join(root, 'package/package.json'));
const { rspack } = packageRequire('@rspack/core');
const version = require(path.join(root, 'package/node_modules/@rspack/core/package.json')).version;
const base = { count: 5000, functions: true, esm: true, css: true, asset: true, mode: 'development' };
const variants = {
  baseline: base,
  strings: { ...base, functions: false },
  commonjs: { ...base, esm: false },
  'no-css': { ...base, css: false },
  'no-asset': { ...base, asset: false },
  production: { ...base, mode: 'production' },
  small: { ...base, count: 50 },
  minimal: { ...base, count: 1, css: false, asset: false, esm: false, functions: false },
};
function generate(v) {
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  for (let i = 0; i < v.count; i++) {
    const name = `Chunk-${String(i).padStart(4, '0')}`;
    fs.writeFileSync(path.join(fixture, `${name}.js`), `${v.css ? `import './${name}.css';\n` : ''}${v.asset ? `export const image = new URL('./${name}.svg', import.meta.url);\n` : ''}export default ${i};\n`);
    if (v.css) fs.writeFileSync(path.join(fixture, `${name}.css`), `.chunk-${i} { color: #123456; }\n`);
    if (v.asset) fs.writeFileSync(path.join(fixture, `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg"><path d="M${i} 0"/></svg>\n`);
  }
  for (let entry = 0; entry < 10; entry++) {
    const lines = [];
    for (let i = entry; i < v.count; i += 10) {
      const name = `Chunk-${String(i).padStart(4, '0')}`;
      lines.push(`import(/* webpackChunkName: "${name}" */ './${name}.js').then(m => console.log(m.default));`);
    }
    fs.writeFileSync(path.join(fixture, `entry-${entry}.js`), lines.join('\n') + '\n');
  }
}
async function build(v) {
  const filename = ext => v.functions ? (() => `[name].${ext}`) : `[name].${ext}`;
  const compiler = rspack({
    context: fixture, mode: v.mode, devtool: false, cache: false,
    entry: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Entry-${i}`, `./entry-${i}.js`])),
    experiments: { css: true, outputModule: v.esm },
    module: { parser: { javascript: { url: 'new-url-relative' } }, rules: [{ test: /\.css$/, type: 'css' }, { test: /\.svg$/, type: 'asset/resource' }] },
    output: { module: v.esm, path: path.join(fixture, 'dist'), clean: true, filename: filename('js'), chunkFilename: filename('js'), cssFilename: filename('css'), cssChunkFilename: filename('css'), publicPath: '' },
    optimization: { minimize: false, splitChunks: false, runtimeChunk: { name: e => `runtime-${e.name}` } },
  });
  const stats = await new Promise((resolve, reject) => compiler.run((err, stats) => err ? reject(err) : resolve(stats)));
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true, errorDetails: true }));
  const chunks = Array.from(stats.compilation.chunks, c => ({ id: c.id, name: c.name, hash: c.hash, contentHash: { ...c.contentHash } })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const files = fs.readdirSync(path.join(fixture, 'dist')).sort().map(name => {
    const bytes = fs.readFileSync(path.join(fixture, 'dist', name));
    const normalized = name.endsWith('.js') ? bytes.toString().replace(/(__webpack_require__\.h\s*=\s*\(\)\s*=>\s*\(?)["'][a-f0-9]+["']/g, '$1"FULL_HASH"') : bytes;
    return [name, crypto.createHash('sha256').update(bytes).digest('hex'), crypto.createHash('sha256').update(normalized).digest('hex')];
  });
  const result = { fullHash: stats.hash, chunks, files };
  await new Promise((resolve, reject) => compiler.close(err => err ? reject(err) : resolve()));
  return result;
}
function compare(a, b) {
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const byId = new Map(b.chunks.map(c => [c.id, c]));
  return {
    fullHash: [a.fullHash, b.fullHash], fullHashEqual: a.fullHash === b.fullHash,
    chunks: a.chunks.length, chunkIdsEqual: same(a.chunks.map(c => c.id), b.chunks.map(c => c.id)),
    changedChunkHashes: a.chunks.filter(c => c.hash !== byId.get(c.id)?.hash).length,
    changedContentHashes: a.chunks.filter(c => !same(c.contentHash, byId.get(c.id)?.contentHash)).length,
    files: a.files.length, filenamesEqual: same(a.files.map(f => f[0]), b.files.map(f => f[0])),
    bytesEqual: same(a.files.map(f => [f[0], f[1]]), b.files.map(f => [f[0], f[1]])),
    normalizedBytesEqual: same(a.files.map(f => [f[0], f[2]]), b.files.map(f => [f[0], f[2]])),
  };
}
(async () => {
  if (process.argv[2] === 'child') {
    const v = JSON.parse(process.argv[3]);
    fs.writeFileSync(process.argv[4], JSON.stringify(await build(v)));
    return;
  }
  const results = { version, variants: {} };
  for (const [name, v] of Object.entries(variants)) {
    generate(v);
    const outputs = [1, 2].map(i => path.join(evidence, `${name}-${i}.json`));
    for (const output of outputs) execFileSync(process.execPath, [__filename, 'child', JSON.stringify(v), output], { stdio: 'inherit' });
    const a = JSON.parse(fs.readFileSync(outputs[0]));
    const b = JSON.parse(fs.readFileSync(outputs[1]));
    results.variants[name] = compare(a, b);
    console.log(name, JSON.stringify(results.variants[name]));
    fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(results, null, 2));
  }
  generate(variants.small);
  const a = await build(variants.small);
  const b = await build(variants.small);
  results.sameProcess = compare(a, b);
  console.log('same-process', JSON.stringify(results.sameProcess));
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(results, null, 2));
})().catch(err => { console.error(err); process.exitCode = 1; });
