const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const [sourceArg, arm, resultArg] = process.argv.slice(2);
const source = fs.realpathSync(sourceArg);
const localRequire = createRequire(path.join(source, 'packages/rspack/package.json'));
const { rspack } = localRequire(path.join(source, 'packages/rspack'));
const pin = fs.realpathSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
const hash = crypto.createHash('sha256').update(fs.readFileSync(pin)).digest('hex');
assert.equal(hash, process.env.EXPECTED_BINDING_SHA256);
if (process.platform === 'linux') {
  const maps = fs.readFileSync('/proc/self/maps', 'utf8');
  assert(maps.includes(pin), `Pinned library is not mapped: ${pin}`);
}
const result = path.resolve(resultArg);
fs.mkdirSync(path.dirname(result), { recursive: true });
const receipt = data => {
  const row = { platform: process.platform, arm, binding: pin, sha256: hash, ...data };
  fs.appendFileSync(result, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
};
receipt({ type: 'identity', mapped: process.platform === 'linux', watchpack: localRequire('watchpack/package.json').version });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(root, file, content, initial = false) {
  const dest = path.join(root, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  if (initial) {
    const past = new Date(Date.now() - 10000);
    fs.utimesSync(dest, past, past);
  }
}
function exportsOf(stats) {
  const module = { exports: {} };
  vm.runInNewContext(stats.compilation.assets['bundle.js'].source().toString(), { module });
  return JSON.parse(JSON.stringify(module.exports));
}
async function scenario(name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR, `alias-${name}-${arm}-`)));
  const nested = name === 'nested';
  let outer = true;
  const files = nested ? {
    'index.js': 'const c = require.context("./ctx", true, /\\.js$/); module.exports = c.keys().sort().map(k => [k, c(k)]);',
    'ctx/existing/seed.txt': 'seed', 'ctx/real/sub/a.js': 'module.exports = 1;',
    'plugin/nested/seed.txt': 'before', 'plugin/kept/deep/file.txt': 'kept'
  } : { 'index.js': 'module.exports = 1;', 'zr/real/f.txt': 'f', 'zr/real/g.txt': 'g' };
  for (const [file, content] of Object.entries(files)) write(root, file, content, true);
  const real = nested ? 'ctx/real' : 'zr/real';
  const link = nested ? 'ctx/link' : 'zr/link';
  fs.symlinkSync(process.platform === 'win32' ? path.join(root, real) : 'real', path.join(root, link), 'junction');
  const compiler = rspack({
    context: root, mode: 'development', devtool: false, target: 'node',
    entry: './index.js', resolve: { symlinks: false },
    output: { path: path.join(root, 'dist'), filename: 'bundle.js', library: { type: 'commonjs2' } },
    experiments: { nativeWatcher: arm !== 'wp' },
    plugins: [compiler => compiler.hooks.thisCompilation.tap('alias-reference', compilation => {
      if (nested) {
        if (outer) compilation.contextDependencies.add(path.join(root, 'plugin'));
        compilation.contextDependencies.add(path.join(root, 'plugin/kept'));
        compilation.fileDependencies.add(path.join(root, 'plugin/kept/deep/file.txt'));
      } else {
        compilation.contextDependencies.add(path.join(root, 'zr/link'));
        compilation.missingDependencies.add(path.join(root, 'zr/m1/m2/m.txt'));
        compilation.fileDependencies.add(path.join(root, 'zr/real/f.txt'));
        compilation.fileDependencies.add(path.join(root, 'zr/link/g.txt'));
      }
    })]
  });
  let builds = 0, pending, last, error, events = [];
  const rel = files => [...files || []].map(file => path.relative(root, file).split(path.sep).join('/')).sort();
  const next = () => new Promise(resolve => {
    const timer = setTimeout(() => { pending = undefined; resolve(false); }, 4000);
    pending = () => { clearTimeout(timer); pending = undefined; resolve(true); };
  });
  const first = next();
  const watching = compiler.watch({ aggregateTimeout: 50, followSymlinks: true }, (err, stats) => {
    builds++;
    last = stats;
    error = err ? String(err) : stats.hasErrors() ? stats.toString() : undefined;
    events.push({ modifiedFiles: rel(compiler.modifiedFiles), removedFiles: rel(compiler.removedFiles), error });
    pending?.();
  });
  async function quiet() {
    let before;
    do { before = builds; await wait(300); } while (before !== builds);
    if (error) throw new Error(error);
  }
  async function step(id, change, expectedOutput) {
    await quiet();
    events = [];
    const done = next();
    change();
    const delivered = await done;
    await quiet();
    const output = nested && last ? exportsOf(last) : undefined;
    receipt({ type: 'step', scenario: name, id, delivered, events, output, expectedOutput,
      outputMatches: expectedOutput ? JSON.stringify(output) === JSON.stringify(expectedOutput) : undefined });
  }
  try {
    assert(await first, 'Initial build did not complete');
    await quiet();
    if (nested) {
      await step('existing-new', () => write(root, 'ctx/existing/new.js', 'module.exports = 1;'));
      await step('deep-new', () => write(root, 'ctx/a/b/c/race.js', 'module.exports = 2;'));
      await step('plugin-new', () => write(root, 'plugin/nested/new.txt', 'new'));
      await step('plugin-edit', () => write(root, 'plugin/nested/seed.txt', 'after'));
      await step('alias-edit', () => write(root, 'ctx/real/sub/a.js', 'module.exports = 2;'), [
        ['./a/b/c/race.js', 2], ['./existing/new.js', 1], ['./link/sub/a.js', 2], ['./real/sub/a.js', 2]
      ]);
      outer = false;
      await step('outer-remove', () => watching.invalidate());
      await wait(300);
      events = [];
      write(root, 'plugin/nested/unused.txt', 'unused');
      await wait(700);
      receipt({ type: 'step', scenario: name, id: 'unused-quiet', delivered: events.length > 0, events });
      await step('kept-edit', () => write(root, 'plugin/kept/deep/file.txt', 'changed'));
      await step('alias-unlink', () => fs.unlinkSync(path.join(root, 'ctx/link')));
      await step('real-new-after-unlink', () => write(root, 'ctx/real/sub/b.js', 'module.exports = 3;'), [
        ['./a/b/c/race.js', 2], ['./existing/new.js', 1], ['./real/sub/a.js', 2], ['./real/sub/b.js', 3]
      ]);
    } else {
      await step('real-f-edit', () => write(root, 'zr/real/f.txt', 'f1'));
      await step('alias-g-edit', () => write(root, 'zr/real/g.txt', 'g1'));
      await step('alias-new', () => write(root, 'zr/real/new.txt', 'n'));
    }
  } finally {
    await new Promise((resolve, reject) => watching.close(err => err ? reject(err) : resolve()));
    receipt({ type: 'closed', scenario: name });
  }
}
(async () => { await scenario('nested'); await scenario('recursive-alias'); })().catch(error => {
  receipt({ type: 'failure', error: error.stack });
  process.exitCode = 1;
});
