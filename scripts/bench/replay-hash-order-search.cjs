const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expectedSha = '7611f57dd6e7e6ab083bf78597b12305e49f0c501c060ea59a2e299e0aa7c61b';
const root = path.resolve('tests/rspack-test/js/replay-hash-order-search');
const results = path.join(root, 'results');
fs.mkdirSync(results, { recursive: true });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function compare(left, right) {
  assert(left && right && typeof left.hash === 'string' && typeof right.hash === 'string');
  assert(Array.isArray(left.assets) && Array.isArray(right.assets));
  assert(left.assets.length > 0 && right.assets.length > 0);
  const names = [...new Set([...left.assets, ...right.assets].map(asset => asset.name))].sort();
  const changed = names.filter(name => {
    const a = left.assets.find(asset => asset.name === name);
    const b = right.assets.find(asset => asset.name === name);
    return !a || !b || !a.bytes.equals(b.bytes);
  });
  return { equalHash: left.hash === right.hash, equalAssets: changed.length === 0, changed };
}

function checkComparison() {
  const a = { hash: 'a', assets: [{ name: 'main.js', bytes: Buffer.from('same') }] };
  assert.deepEqual(compare(a, a), { equalHash: true, equalAssets: true, changed: [] });
  assert.equal(compare(a, { ...a, hash: 'b' }).equalHash, false);
  assert.equal(compare(a, { ...a, assets: [{ name: 'other.js', bytes: Buffer.from('same') }] }).equalAssets, false);
  assert.equal(compare(a, { ...a, assets: [{ name: 'main.js', bytes: Buffer.from('changed') }] }).equalAssets, false);
  assert.throws(() => compare(a, undefined));
  assert.throws(() => compare(a, { hash: 'a', assets: [] }));
}
checkComparison();

const binding = fs.realpathSync('crates/node_binding/rspack.linux-x64-gnu.node');
assert.equal(digest(fs.readFileSync(binding)), expectedSha, 'Binding checksum does not match');
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
const { rspack } = require('../../packages/rspack/dist');
const mapped = [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n')
  .filter(line => line.includes('rspack') && line.includes('.node'))
  .map(line => fs.realpathSync(line.slice(line.indexOf('/')))))];
assert.deepEqual(mapped, [binding], 'The process must map only the pinned binding');
const identity = { sha256: digest(fs.readFileSync(mapped[0])), mapped, node: process.version };
assert.equal(identity.sha256, expectedSha);
fs.writeFileSync(path.join(results, 'binding.json'), JSON.stringify(identity, null, 2));
console.log('BINDING', JSON.stringify(identity));

const cases = [];
for (const groupCount of [130, 4]) {
  for (const feature of ['named-reuse', 'max-size', 'reuse-existing', 'min-size-removal', 'stable-size']) {
    cases.push({ name: `${feature}-${groupCount}`, feature, groupCount });
  }
}

function prepare(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const entry = 'import a from "./a.js"; import b from "./b.js"; import c from "./c.js"; import d from "./d.js"; import e from "./e.js"; console.log(a,b,c,d,e,__webpack_hash__);';
  for (const name of ['alpha', 'beta']) fs.writeFileSync(path.join(directory, `${name}.js`), entry);
  for (const [name, size] of [['a', 60000], ['b', 80000], ['c', 40000], ['d', 80000], ['e', 10000]]) {
    fs.writeFileSync(path.join(directory, `${name}.js`), `export default ${JSON.stringify(name.repeat(size))};`);
  }
}

function options(directory, candidate) {
  const cacheGroups = {
    default: false,
    defaultVendors: false,
    first: { test: /[\\/][ac]\.js$/, name: () => 'shared', minChunks: 2 },
    second: { test: /[\\/]b\.js$/, name: () => 'other', minChunks: 2 },
    reuse: { test: /[\\/]d\.js$/, name: () => 'shared', minChunks: 2 },
    small: { test: /[\\/]e\.js$/, name: () => 'small', minChunks: 2 },
  };
  for (let i = 4; i < candidate.groupCount; i++) {
    cacheGroups[`padding${i}`] = {
      test: i < 11 ? module => module.resource?.endsWith(`/padding${i}.js`) : new RegExp(`padding${i}\\.js$`),
      name: `padding${i}`,
      ...(i === 4 ? { chunks: chunk => chunk.name !== 'runtime' } : {}),
    };
  }
  if (candidate.feature === 'reuse-existing') {
    for (const key of ['first', 'second', 'reuse']) {
      cacheGroups[key].name = false;
      cacheGroups[key].reuseExistingChunk = true;
    }
  }
  return {
    context: directory,
    entry: { alpha: './alpha.js', beta: './beta.js' },
    mode: 'development',
    devtool: false,
    cache: false,
    incremental: true,
    output: { path: path.join(directory, 'dist'), filename: '[name].js' },
    optimization: {
      minimize: false,
      concatenateModules: false,
      runtimeChunk: 'single',
      moduleIds: 'deterministic',
      chunkIds: 'deterministic',
      splitChunks: {
        chunks: 'all',
        minSize: 50000,
        ...(candidate.feature === 'max-size' ? { maxSize: 100000 } : {}),
        cacheGroups,
      },
    },
  };
}

function run(compiler, candidate, arm, step, changed = []) {
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      if (error || !stats || stats.hasErrors()) return reject(error || new Error(stats?.toString()));
      try {
        const assets = stats.compilation.getAssets().map(({ name, source }) => ({ name, bytes: source.buffer() })).sort((a, b) => a.name.localeCompare(b.name));
        const logging = stats.toJson({ all: false, logging: 'verbose' }).logging;
        const replay = Object.values(logging || {}).flatMap(log => log.entries || []).map(entry => entry.message).filter(message => message.includes('replay:'));
        const chunks = [...stats.compilation.chunks].map(chunk => ({ id: chunk.id, name: chunk.name, hash: chunk.hash, contentHash: chunk.contentHash, modules: [...stats.compilation.chunkGraph.getChunkModulesIterable(chunk)].map(module => path.relative(compiler.context, module.resource || module.identifier())).sort() })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const snapshot = { candidate: candidate.name, arm, step, hash: stats.hash, assets, replay, chunks };
        const target = path.join(results, candidate.name, arm, `step${step}`);
        for (const asset of assets) {
          const file = path.join(target, asset.name);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, asset.bytes);
        }
        fs.appendFileSync(path.join(results, 'builds.jsonl'), JSON.stringify({ ...snapshot, assets: assets.map(asset => ({ name: asset.name, sha256: digest(asset.bytes), size: asset.bytes.length })) }) + '\n');
        resolve(snapshot);
      } catch (error) { reject(error); }
    }, { modifiedFiles: new Set(changed) });
  });
}
const close = compiler => new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));

async function search() {
  const comparisons = [];
  for (const candidate of cases) {
    const directory = path.join(root, 'fixtures', candidate.name);
    const arms = {};
    for (const arm of ['off', 'on']) {
      process.env.RSPACK_SPLIT_CHUNKS_REPLAY = arm === 'on' ? '1' : '0';
      prepare(directory);
      const compiler = rspack(options(directory, candidate));
      try {
        arms[arm] = [await run(compiler, candidate, arm, 0)];
        const name = candidate.feature === 'min-size-removal' ? 'e' : 'b';
        const size = candidate.feature === 'stable-size' ? 80000 : candidate.feature === 'min-size-removal' ? 60000 : 120000;
        const file = path.join(directory, `${name}.js`);
        fs.writeFileSync(file, `export default ${JSON.stringify('z'.repeat(size))};`);
        arms[arm].push(await run(compiler, candidate, arm, 1, [file]));
      } finally { await close(compiler); }
    }
    assert.equal(compare(arms.off[0], arms.on[0]).equalHash, true, 'Initial build hashes must agree');
    assert.equal(compare(arms.off[0], arms.on[0]).equalAssets, true, 'Initial build assets must agree');
    assert(arms.on[1].replay.some(message => message.includes('replayed')), `Replay did not run for ${candidate.name}`);
    const comparison = { candidate: candidate.name, step: 1, off: arms.off[1].hash, on: arms.on[1].hash, ...compare(arms.off[1], arms.on[1]), equalChunkMembership: JSON.stringify(arms.off[1].chunks.map(({ id, modules }) => ({ id, modules }))) === JSON.stringify(arms.on[1].chunks.map(({ id, modules }) => ({ id, modules }))), replay: arms.on[1].replay };
    comparisons.push(comparison);
    fs.writeFileSync(path.join(results, 'comparisons.json'), JSON.stringify(comparisons, null, 2));
    console.log('COMPARISON', JSON.stringify(comparison));
    if (!comparison.equalHash) {
      fs.writeFileSync(path.join(results, 'found.json'), JSON.stringify({ candidate, comparison }, null, 2));
      console.log('FOUND_MISMATCH', candidate.name);
      return;
    }
  }
  console.log('NO_MISMATCH', comparisons.length);
}
search().catch(error => {
  fs.writeFileSync(path.join(results, 'error.txt'), error.stack || String(error));
  console.error(error);
  process.exitCode = 1;
});
