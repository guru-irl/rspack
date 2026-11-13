require('../pin-native.cjs');
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
if(process.platform==='linux') assert(fs.readFileSync('/proc/self/maps', 'utf8').includes(binding));
const result = path.resolve(resultArg);
fs.mkdirSync(path.dirname(result), { recursive: true });
const receipt = row => { const text = JSON.stringify({ binding, sha256, watchpack: version, ...row }); fs.appendFileSync(result, text + '\n'); console.log(text); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function scenario(native, followSymlinks) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR, 'paired-alias-')));
  const full = name => path.join(root, name);
  for (const [file, content] of Object.entries({
    'index.js': 'const c = require.context("./ctx", true, /\\.js$/); module.exports = c.keys().sort().map(k => [k, c(k)]);',
    'ctx/real/sub/a.js': 'module.exports = "a";',
    'outside/in.js': 'module.exports = "in";'
  })) { fs.mkdirSync(path.dirname(full(file)), { recursive: true }); fs.writeFileSync(full(file), content); const past = new Date(Date.now() - 60000); fs.utimesSync(full(file), past, past); }
  fs.symlinkSync(full('ctx/real'), full('ctx/link'), process.platform==='win32'?'junction':'dir');
  const compiler = rspack({ context: root, mode: 'development', devtool: false, target: 'node', entry: './index.js', resolve: { symlinks: false }, output: { path: full('dist'), filename: 'bundle.js', library: { type: 'commonjs2' } }, experiments: { nativeWatcher: native } });
  let builds = 0, last, error, events = [];
  const rel = items => [...items || []].map(file => path.relative(root, file).split(path.sep).join('/')).sort();
  const watching = compiler.watch({ aggregateTimeout: 100, followSymlinks }, (err, stats) => {
    last = stats; error = err || (stats.hasErrors() ? Error(stats.toString()) : undefined); builds++;
    events.push({ modifiedFiles: rel(compiler.modifiedFiles), removedFiles: rel(compiler.removedFiles) });
  });
  async function until(predicate, required=true) { const end = Date.now() + 10000; while (!predicate()) { if(error||Date.now()>end){if(required)throw error||Error('rebuild timeout');return false;} await wait(20); } if(error){if(required)throw error;return false;}return true; }
  async function settle() { let before; do { before = builds; await wait(400); } while (before !== builds || watching.running); if (error) throw error; }
  const rows = [];
  try {
    await until(() => builds > 0 && !watching.running); await settle();
    for (const [id, from, to] of [
      ['inside', 'ctx/real/sub/a.js', 'ctx/real/sub/b.js'],
      ['incoming', 'outside/in.js', 'ctx/real/sub/in.js'],
      ['outgoing', 'ctx/real/sub/b.js', 'outside/out.js']
    ]) {
      events = []; const before = builds;
      fs.renameSync(full(from), full(to));
      await until(() => builds > before && !watching.running, false); await settle();
      const module = { exports: {} }; vm.runInNewContext(last.compilation.assets['bundle.js'].source().toString(), { module });
      const modules = rel([...last.compilation.modules].map(m => m.resource).filter(file => typeof file === 'string' && file.startsWith(root)));
      const row = { type: 'step', native, followSymlinks, id,
        modifiedFiles: [...new Set(events.flatMap(e => e.modifiedFiles))].sort(),
        removedFiles: [...new Set(events.flatMap(e => e.removedFiles))].sort(),
        delivered:events.length>0, modules, output: JSON.parse(JSON.stringify(module.exports)), events };
      receipt(row); rows.push(row);
    }
  } finally { await new Promise((resolve, reject) => watching.close(err => err ? reject(err) : resolve())); fs.rmSync(root, { recursive: true, force: true }); }
  return rows;
}
(async () => {
  let failures = 0;
  for (const follow of [true, false]) {
    const reference = await scenario(false, follow);
    const actual = await scenario(true, follow);
    for (let i = 0; i < reference.length; i++) {
      const fields = ['modifiedFiles', 'removedFiles', 'modules', 'output'];
      const differences = fields.filter(key => JSON.stringify(actual[i][key]) !== JSON.stringify(reference[i][key]));
      receipt({ type: 'comparison', followSymlinks: follow, id: reference[i].id, parity: differences.length === 0, differences });
      failures += differences.length > 0;
    }
  }
  receipt({ type: 'summary', rows: 6, failures });
  if (failures) process.exitCode = 1;
})().catch(error => { receipt({ type: 'failure', error: error.stack }); process.exitCode = 1; });
