const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const [sourceArg, resultArg] = process.argv.slice(2);
const source = fs.realpathSync(sourceArg);
const req = createRequire(path.join(source, 'packages/rspack/package.json'));
const { rspack } = req(path.join(source, 'packages/rspack/dist/index.js'));
const version = req('watchpack/package.json').version;
assert.equal(version, '2.6.3');
const binding = fs.realpathSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binding)).digest('hex');
assert.equal(sha256, process.env.EXPECTED_BINDING_SHA256);
assert(fs.readFileSync('/proc/self/maps', 'utf8').includes(binding));
const result = path.resolve(resultArg);
fs.mkdirSync(path.dirname(result), { recursive: true });
const receipt = row => { const text = JSON.stringify({ binding, sha256, watchpack: version, ...row }); fs.appendFileSync(result, text + '\n'); console.log(text); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function scenario(native, followSymlinks, operation) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR, 'atomic-alias-')));
  const full = name => path.join(root, name);
  for (const [file, content] of Object.entries({
    'index.js': 'const c = require.context("./ctx", true, /\\.js$/); module.exports = c.keys().sort().map(k => [k, c(k)]);',
    'ctx/real/sub/a.js': 'module.exports = "a-old";',
    'ctx/real/sub/b.js': 'module.exports = "b-old";'
  })) { fs.mkdirSync(path.dirname(full(file)), { recursive: true }); fs.writeFileSync(full(file), content); const past = new Date(Date.now() - 60000); fs.utimesSync(full(file), past, past); }
  fs.symlinkSync('real', full('ctx/link'));
  const compiler = rspack({ context: root, mode: 'development', devtool: false, target: 'node', entry: './index.js', resolve: { symlinks: false }, output: { path: full('dist'), filename: 'bundle.js', library: { type: 'commonjs2' } }, experiments: { nativeWatcher: native } });
  let builds = 0, last, error, events = [];
  const rel = items => [...items || []].map(file => path.relative(root, file).split(path.sep).join('/')).sort();
  const watching = compiler.watch({ aggregateTimeout: 100, followSymlinks }, (err, stats) => {
    last = stats; error = err || (stats.hasErrors() ? Error(stats.toString()) : undefined); builds++;
    events.push({ modifiedFiles: rel(compiler.modifiedFiles), removedFiles: rel(compiler.removedFiles) });
  });
  async function until(predicate) { const end = Date.now() + 10000; while (!predicate()) { if (error) throw error; if (Date.now() > end) throw Error('rebuild timeout'); await wait(20); } if (error) throw error; }
  async function settle() { let before; do { before = builds; await wait(400); } while (before !== builds || watching.running); if (error) throw error; }
  try {
    await until(() => builds > 0 && !watching.running); await settle();
    events = []; let before = builds; const start = Date.now(); let gapMs;
    const a = full('ctx/real/sub/a.js');
    if (operation === 'atomic') {
      fs.writeFileSync(a + '.tmp', 'module.exports = "a-new";'); fs.renameSync(a + '.tmp', a);
    } else if (operation.startsWith('backup')) {
      fs.renameSync(a, a + '~');
      if (operation === 'backup-gap') { await until(() => builds > before && !watching.running); await settle(); before = builds; }
      gapMs = Date.now() - start;
      if (operation === 'backup-gap') assert(gapMs > 100); else assert(gapMs < 100);
      fs.writeFileSync(a, 'module.exports = "a-new";');
    } else if (operation === 'tracked-overwrite') { fs.renameSync(a, full('ctx/real/sub/b.js')); }
    else throw Error('Unknown operation');
    await until(() => builds > before && !watching.running); await settle();
    const module = { exports: {} }; vm.runInNewContext(last.compilation.assets['bundle.js'].source().toString(), { module });
    const modules = rel([...last.compilation.modules].map(m => m.resource).filter(file => typeof file === 'string' && file.startsWith(root)));
    const row = { type: 'step', native, followSymlinks, id: operation, gapMs,
      modifiedFiles: [...new Set(events.flatMap(e => e.modifiedFiles))].sort(),
      removedFiles: [...new Set(events.flatMap(e => e.removedFiles))].sort(),
      modules, output: JSON.parse(JSON.stringify(module.exports)), events };
    receipt(row); return row;
  } finally { await new Promise((resolve, reject) => watching.close(err => err ? reject(err) : resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}
(async () => {
  let failures = 0;
  for (const follow of [true, false]) for (const operation of ['atomic', 'backup-immediate', 'backup-gap', 'tracked-overwrite']) {
    const reference = await scenario(false, follow, operation);
    const actual = await scenario(true, follow, operation);
    const fields = ['modifiedFiles', 'removedFiles', 'modules', 'output'];
    const differences = fields.filter(key => JSON.stringify(actual[key]) !== JSON.stringify(reference[key]));
    receipt({ type: 'comparison', followSymlinks: follow, id: operation, parity: differences.length === 0, differences });
    failures += differences.length > 0;
  }
  receipt({ type: 'summary', rows: 8, failures });
  if (failures) process.exitCode = 1;
})().catch(error => { receipt({ type: 'failure', error: error.stack }); process.exitCode = 1; });
