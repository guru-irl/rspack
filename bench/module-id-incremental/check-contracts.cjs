'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { rspack } = require('../../packages/rspack');
const root = __dirname;
const arm = process.env.ARM_LABEL;
assert(['main', 'branch'].includes(arm));
const records = [];
async function check(kind) {
  const fixture = path.join(root, 'contracts-fixture');
  fs.mkdirSync(fixture, { recursive: true });
  const source = name => `module.exports = { id: module.id, value: '${name}' };\n`;
  const entry = added => `${added ? "const added = require('./added');\n" : ''}module.exports = { target: require('./target'), steady: require('./steady'), edited: require('./edited')${added ? ', added' : ''} };\n`;
  fs.writeFileSync(path.join(fixture, 'index.js'), entry(false));
  for (const name of ['target', 'steady', 'edited', 'added']) fs.writeFileSync(path.join(fixture, name + '.js'), source(name));
  let step = 0;
  let originalTarget;
  let notify;
  const compiler = rspack({
    context: fixture, entry: './index.js', target: 'node', mode: 'development', devtool: false,
    incremental: kind !== 'nonincremental', cache: true,
    output: { path: path.join(root, 'contracts-output'), filename: 'main.js', library: { type: 'commonjs2' }, pathinfo: false },
    optimization: { moduleIds: 'compact-hashed', chunkIds: 'named', minimize: false, concatenateModules: false },
    plugins: kind.startsWith('custom') ? [{ apply(compiler) {
      compiler.hooks.compilation.tap('CustomAssignments', compilation => {
        compilation.hooks.beforeModuleIds.tap('CustomAssignments', modules => {
          for (const module of modules) {
            if (kind === 'custom-change' && step > 0 && module.identifier.endsWith('/target.js')) module.id = 'custom-target';
            if (kind === 'custom-conflict' && step === 2 && module.identifier.endsWith('/added.js')) module.id = originalTarget;
          }
        });
      });
    } }] : [],
  });
  compiler.watchFileSystem = { watch(_files, _dirs, _missing, _start, _options, callback) {
    notify = callback;
    return { close() {}, pause() {}, getInfo() { return { changes: new Set(), removals: new Set(), fileTimeInfoEntries: new Map(), contextTimeInfoEntries: new Map() }; } };
  } };
  let watching;
  let previous;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Contract timeout ' + kind)), 120000);
    let finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      watching.close(() => compiler.close(closeError => error || closeError ? reject(error || closeError) : resolve()));
    }
    watching = compiler.watch({}, (error, stats) => {
      if (error || stats.hasErrors()) return finish(error || new Error(stats.toString()));
      try {
        const file = path.join(root, 'contracts-output/main.js');
        delete require.cache[require.resolve(file)];
        const result = require(file);
        assert.equal(result.target.value, 'target');
        assert.equal(result.steady.value, 'steady');
        assert.equal(result.edited.value, step ? 'updated' : 'edited');
        if (step === 2 || step === 4) assert.equal(result.added.value, 'added');
        const json = stats.toJson({ all: false, modules: true, cachedModules: true, ids: true, groupModulesByCacheStatus: false });
        const modules = json.modules.filter(module => module.moduleType !== 'runtime');
        const ids = Object.fromEntries(modules.map(module => [module.name, module.id]));
        assert.equal(new Set(Object.values(ids)).size, modules.length);
        assert.equal(result.target.id, ids['./target.js']);
        if (result.added) assert.equal(result.added.id, ids['./added.js']);
        if (!step) originalTarget = result.target.id;
        if (arm === 'branch' && kind === 'plain' && previous) {
          for (const [name, id] of Object.entries(previous)) if (name in ids) assert.equal(ids[name], id, name);
        }
        if (kind === 'custom-change' && step) assert.equal(result.target.id, 'custom-target');
        if (kind === 'custom-conflict' && step === 2) {
          assert.equal(result.added.id, originalTarget);
          assert.notEqual(result.target.id, originalTarget);
        }
        records.push({ kind, step, ids, codegenProcessed: modules.filter(module => module.codeGenerated).length, outputHash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
        previous = ids;
        step++;
        if (step === 5) return finish();
        setImmediate(() => {
          try {
            const changes = new Set();
            const removals = new Set();
            const write = (name, value) => { const file = path.join(fixture, name); fs.writeFileSync(file, value); changes.add(file); };
            if (step === 1) write('edited.js', source('updated'));
            else if (step === 3) {
              write('index.js', entry(false));
              const file = path.join(fixture, 'added.js'); fs.unlinkSync(file); removals.add(file);
            } else {
              write('added.js', source('added'));
              write('index.js', entry(true));
            }
            compiler.inputFileSystem.purge([...changes, ...removals]);
            notify(null, new Map(), new Map(), changes, removals);
          } catch (error) { finish(error); }
        });
      } catch (error) { finish(error); }
    });
  });
}
(async () => {
  for (const kind of ['plain', 'nonincremental', 'custom-change', 'custom-conflict']) await check(kind);
  const destination = path.join(root, 'data', arm + '-contracts.json');
  fs.writeFileSync(destination, JSON.stringify(records, null, 2));
  if (arm === 'branch') {
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'data/main-contracts.json')));
    for (const row of records) if (!row.step || row.kind === 'nonincremental') {
      const before = baseline.find(value => value.kind === row.kind && value.step === row.step);
      assert.deepEqual(row.ids, before.ids);
      assert.equal(row.outputHash, before.outputHash);
    }
  }
  console.log('PASS cold/nonincremental parity, custom assignments, conflicts, removal and re-addition:', arm);
})().catch(error => { console.error(error); process.exitCode = 1; });
