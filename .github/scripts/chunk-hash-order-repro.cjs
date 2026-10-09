const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve('.hash-repro');
const fixture = path.join(root, 'order-fixture');
const packageRequire = createRequire(path.join(root, 'package/package.json'));
const { rspack } = packageRequire('@rspack/core');
fs.mkdirSync(fixture, { recursive: true });
for (const name of ['left', 'right']) {
  fs.writeFileSync(path.join(fixture, `${name}.js`), `console.log(new URL('./${name}.svg', import.meta.url));\n`);
  fs.writeFileSync(path.join(fixture, `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title></svg>\n`);
}
fs.writeFileSync(path.join(fixture, 'delay.cjs'), `const path = require('node:path');\nmodule.exports = function(source) {\n const callback = this.async();\n setTimeout(() => callback(null, source), path.basename(this.resourcePath) === this.getOptions().delayed ? 100 : 0);\n};\n`);
async function build(delayed, url) {
  const generated = {};
  const moduleHashes = {};
  const compiler = rspack({
    context: fixture, mode: 'development', cache: false, devtool: false,
    entry: { left: './left.js', right: './right.js' },
    output: { path: path.join(fixture, 'dist'), clean: true, filename: '[name].js', publicPath: '' },
    module: { parser: { javascript: { url } }, rules: [
      { test: /\.js$/, use: [{ loader: path.join(fixture, 'delay.cjs'), ident: 'delay', options: { delayed } }] },
      { test: /\.svg$/, type: 'asset/resource' },
    ] },
    plugins: [{ apply(compiler) {
      compiler.hooks.compilation.tap('CaptureGeneratedSource', compilation => {
        compilation.hooks.processAssets.tap('CaptureGeneratedSource', () => {
          for (const module of compilation.modules) {
            if (module.resource && /\/(left|right)\.js$/.test(module.resource)) {
              const source = compilation.codeGenerationResults.get(module, undefined).sources.get('javascript');
              generated[path.basename(module.resource)] = source.source().toString();
              moduleHashes[path.basename(module.resource)] = compilation.chunkGraph.getModuleHash(module, undefined);
            }
          }
        });
      });
    } }],
  });
  const stats = await new Promise((resolve, reject) => compiler.run((err, stats) => err ? reject(err) : resolve(stats)));
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
  const chunks = Array.from(stats.compilation.chunks, c => ({ id: c.id, hash: c.hash, contentHash: { ...c.contentHash } })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const files = fs.readdirSync(path.join(fixture, 'dist')).sort().map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture, 'dist', name))).digest('hex')]);
  const result = { fullHash: stats.hash, chunks, files, generated, moduleHashes };
  await new Promise((resolve, reject) => compiler.close(err => err ? reject(err) : resolve()));
  return result;
}
(async () => {
  const results = {};
  for (const url of ['new-url-relative', true]) {
    try {
      const a = await build('left.js', url);
      const b = await build('right.js', url);
      const stableGenerated = value => Object.fromEntries(Object.entries(value).sort().map(([name, source]) => [name, source.replace(/RSPACK_AUTO_URL_STATIC_PLACEHOLDER_\d+/g, 'RSPACK_AUTO_URL_STATIC_PLACEHOLDER_ID')]));
      results[String(url)] = {
        a, b, fullHashEqual: a.fullHash === b.fullHash,
        chunkHashesEqual: JSON.stringify(a.chunks) === JSON.stringify(b.chunks),
        filesEqual: JSON.stringify(a.files) === JSON.stringify(b.files),
        normalizedGeneratedEqual: JSON.stringify(stableGenerated(a.generated)) === JSON.stringify(stableGenerated(b.generated)),
      };
    } catch (err) {
      results[String(url)] = { error: String(err) };
    }
  }
  fs.writeFileSync(path.join(root, 'evidence/order-repro.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch(err => { console.error(err); process.exitCode = 1; });
