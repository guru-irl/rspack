import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.env.SC_FIXTURE_ROOT);
const resultPath = process.env.SC_RESULT;
const moduleCount = 4096;
const entryCount = 16;
const groupCount = 16;
const { rspack } = await import(pathToFileURL(path.resolve('packages/rspack/dist/index.js')).href);
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
for (let index = 0; index < moduleCount; index++) {
  fs.writeFileSync(path.join(root, 'src', `shared-${index}.js`), `export const value = ${index};\n`);
}
const entry = {};
for (let index = 0; index < entryCount; index++) {
  const imports = [];
  for (let module = 0; module < moduleCount; module++) {
    // Two fixed owners ensure sharing, with six variable owners on either side.
    const owners = (module % 64) + 1;
    if (index < 2 || ((owners >>> ((index - 2) % 6)) & 1)) {
      imports.push(`import { value as v${module} } from './shared-${module}.js';`);
    }
  }
  fs.writeFileSync(path.join(root, 'src', `entry-${index}.js`), `${imports.join('\n')}\nconsole.log([${imports.map(line => /as (v\d+)/.exec(line)[1]).join(',')}]);\n`);
  entry[`entry-${index}`] = `./entry-${index}.js`;
}
const counts = { test: 0, chunks: 0, name: 0 };
const groups = { default: false, defaultVendors: false };
for (let group = 0; group < groupCount; group++) {
  groups[`group-${group}`] = {
    minChunks: 2,
    minSize: 0,
    test(module) {
      counts.test++;
      const match = /shared-(\d+)\.js$/.exec(module.resource || '');
      return !!match && Number(match[1]) % groupCount === group;
    },
    chunks(chunk) {
      counts.chunks++;
      return chunk.name?.startsWith('entry-') === true;
    },
    name(_module, _chunks, key) {
      counts.name++;
      return `shared-${key}`;
    },
  };
}
let optimizeStart;
let optimizeMs;
const compiler = rspack({
  context: path.join(root, 'src'),
  mode: 'development',
  target: 'node',
  cache: false,
  devtool: false,
  entry,
  output: { path: path.join(root, 'dist'), filename: '[name].js', chunkFilename: '[name].js', clean: true },
  optimization: {
    minimize: false,
    concatenateModules: false,
    usedExports: false,
    inlineExports: false,
    splitChunks: { chunks: 'all', minSize: 0, minChunks: 2, usedExports: false, dedupDepth: 0, maxAsyncRequests: Infinity, maxInitialRequests: Infinity, cacheGroups: groups },
  },
  plugins: [{
    apply(compiler) {
      compiler.hooks.thisCompilation.tap('MeasureSplitChunks', compilation => {
        compilation.hooks.optimizeChunks.tap({ name: 'MeasureSplitChunksStart', stage: -10000 }, () => { optimizeStart = performance.now(); });
        compilation.hooks.optimizeChunks.tap({ name: 'MeasureSplitChunksEnd', stage: 10000 }, () => { optimizeMs = performance.now() - optimizeStart; });
      });
    },
  }],
});
const records = [];
const changed = path.join(root, 'src/shared-0.js');
try {
  for (const phase of ['cold', 'edit', 'revert']) {
    if (phase !== 'cold') fs.writeFileSync(changed, `export const value = ${phase === 'edit' ? 999999 : 0};\n`);
    compiler.modifiedFiles = new Set(phase === 'cold' ? [] : [changed]);
    counts.test = counts.chunks = counts.name = 0;
    const start = performance.now();
    const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)));
    const wallMs = performance.now() - start;
    if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
    if (counts.test < moduleCount * groupCount || counts.chunks === 0 || counts.name < moduleCount) {
      throw new Error(`Fixture failed qualification: ${JSON.stringify(counts)}`);
    }
    const hashes = Object.fromEntries(stats.compilation.getAssets().sort((a, b) => a.name.localeCompare(b.name)).map(asset => [asset.name, crypto.createHash('sha256').update(asset.source.buffer()).digest('hex')]));
    global.gc?.();
    records.push({ phase, wallMs, optimizeMs, counts: { ...counts }, modules: stats.compilation.modules.size, chunks: stats.compilation.chunks.size, hashes, steadyRssBytes: process.memoryUsage().rss, peakRssKiB: process.resourceUsage().maxRSS });
  }
} finally {
  await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
}
fs.writeFileSync(resultPath, JSON.stringify({ records }, null, 2));
console.log(JSON.stringify(records.map(({ hashes, ...record }) => record))));
