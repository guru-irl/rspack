// Extra alias steps for the c3 review: link chains, case and short spellings,
// context root deletion and link retargeting. Records receipts; never asserts parity.
// usage: node c3-steps.cjs <source> <arm> <result.jsonl>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const [sourceArg, arm, resultArg] = process.argv.slice(2);
const source = fs.realpathSync(sourceArg);
const localRequire = createRequire(path.join(source, 'packages/rspack/package.json'));
const { rspack } = localRequire(path.join(source, 'packages/rspack/dist/index.js'));
const pin = fs.realpathSync.native(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
const hash = crypto.createHash('sha256').update(fs.readFileSync(pin)).digest('hex');
assert.equal(hash, process.env.EXPECTED_BINDING_SHA256);
const win = process.platform === 'win32';
const norm = p => (win ? p.toLowerCase() : p);
const result = path.resolve(resultArg);
fs.mkdirSync(path.dirname(result), { recursive: true });
const receipt = data => {
  const row = { platform: process.platform, arm, sha256: hash, ...data };
  fs.appendFileSync(result, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
};
function loadedIdentity() {
  const objects = process.report.getReport().sharedObjects.filter(p => /\.node$/i.test(p));
  const loaded = objects.map(p => {
    let real = p; try { real = fs.realpathSync.native(p); } catch {}
    let sha = null; try { sha = crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex'); } catch {}
    return { path: p, real, sha256: sha };
  });
  let maps = null;
  if (process.platform === 'linux') maps = fs.readFileSync('/proc/self/maps', 'utf8').includes(pin);
  const mine = loaded.filter(o => norm(o.real) === norm(pin) && o.sha256 === hash);
  const others = loaded.filter(o => norm(o.real) !== norm(pin) && /rspack/i.test(path.basename(o.real)));
  const ok = mine.length === 1 && others.length === 0 && maps !== false;
  return { ok, pin, loaded, maps };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(root, file, content, initial = false) {
  const dest = path.join(root, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  if (initial) { const past = new Date(Date.now() - 10000); fs.utimesSync(dest, past, past); }
}
function link(root, target, at) {
  const dest = path.join(root, at);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (win) fs.symlinkSync(path.join(root, target), dest, 'junction');
  else fs.symlinkSync(path.relative(path.dirname(dest), path.join(root, target)), dest);
}
const ctxIndex = dir => `const c = require.context(${JSON.stringify(dir)}, true, /\\.js$/); module.exports = c.keys().sort().map(k => [k, c(k)]);`;
function makeRoot(name, base) {
  const dir = fs.mkdtempSync(path.join(base || process.env.TMPDIR || os.tmpdir(), `c3-${name}-${arm}-`));
  return dir;
}
async function scenario(name, opts) {
  const root = opts.root || fs.realpathSync.native(makeRoot(name));
  const rootReal = fs.realpathSync.native(root);
  opts.setup(root);
  const state = opts.state || {};
  const compiler = rspack({
    context: root, mode: 'development', devtool: false, target: 'node',
    entry: './index.js', resolve: { symlinks: false },
    output: { path: path.join(rootReal, 'dist'), filename: 'bundle.js', library: { type: 'commonjs2' } },
    experiments: { nativeWatcher: arm !== 'wp' },
    plugins: [compiler => compiler.hooks.thisCompilation.tap('c3', compilation => {
      for (const p of state.contexts || []) compilation.contextDependencies.add(path.join(root, p));
      for (const p of state.files || []) compilation.fileDependencies.add(path.join(root, p));
      for (const p of state.missing || []) compilation.missingDependencies.add(path.join(root, p));
    })]
  });
  let builds = 0, pending, last, events = [];
  const rel = files => [...files || []].map(file => {
    for (const [base, tag] of [[root, ''], [rootReal, 'REAL:']]) {
      const r = path.relative(base, file);
      if (!r.startsWith('..') && !path.isAbsolute(r)) return tag + r.split(path.sep).join('/');
    }
    return 'ABS:' + file;
  }).sort();
  const next = ms => new Promise(resolve => {
    const timer = setTimeout(() => { pending = undefined; resolve(false); }, ms || 4000);
    pending = () => { clearTimeout(timer); pending = undefined; resolve(true); };
  });
  const first = next(60000);
  const watching = compiler.watch({ aggregateTimeout: 50, followSymlinks: true }, (err, stats) => {
    builds++;
    last = stats;
    const error = err ? String(err).slice(0, 300) : stats.hasErrors() ? stats.toString().slice(0, 300) : undefined;
    events.push({ modifiedFiles: rel(compiler.modifiedFiles), removedFiles: rel(compiler.removedFiles), error });
    pending?.();
  });
  async function quiet() { let before; const t = Date.now(); do { before = builds; await wait(300); } while (before !== builds && Date.now() - t < 15000); }
  const output = () => {
    try {
      const module = { exports: {} };
      vm.runInNewContext(last.compilation.assets['bundle.js'].source().toString(), { module });
      return JSON.parse(JSON.stringify(module.exports));
    } catch (e) { return 'ERR'; }
  };
  async function step(id, change) {
    await quiet();
    events = [];
    const done = next();
    await change();
    const delivered = await done;
    await quiet();
    receipt({ type: 'step', scenario: name, id, delivered, events, output: output(), errors: last && last.hasErrors() });
    if (!delivered) {
      // Resynchronize so the next step starts from the same state on every arm.
      events = [];
      const r = next(8000); watching.invalidate(); await r; await quiet();
      receipt({ type: 'resync', scenario: name, id, output: output() });
    }
  }
  try {
    assert(await first, 'Initial build did not complete');
    await quiet();
    receipt({ type: 'init', scenario: name, root, rootReal, output: output(), identity: loadedIdentity() });
    await opts.run({ root, step, state, watching });
  } catch (error) {
    receipt({ type: 'failure', scenario: name, error: String(error && error.stack || error) });
  } finally {
    await new Promise(resolve => watching.close(() => resolve()));
    receipt({ type: 'closed', scenario: name });
  }
}
const W = (root, file, v) => write(root, file, `module.exports = ${v};`);
const scenarios = {
  // A link inside a link target, and a link to a link.
  chain: () => scenario('chain', {
    setup: root => {
      write(root, 'index.js', ctxIndex('./ctx'), true);
      write(root, 'ctx/real/a.js', 'module.exports = 1;', true);
      write(root, 'ext/t/x.js', 'module.exports = 1;', true);
      link(root, 'ctx/real', 'ctx/link');
      link(root, 'ext/t', 'ctx/real/inner');
      link(root, 'ctx/link', 'ctx/link2');
    },
    run: async ({ root, step }) => {
      await step('chain-edit-inner', () => W(root, 'ext/t/x.js', 2));
      await step('chain-new-inner', () => W(root, 'ext/t/y.js', 3));
      await step('chain-edit-via-link2', () => W(root, 'ctx/link2/a.js', 4));
      await step('chain-new-deep', () => W(root, 'ext/t/d/e.js', 5));
      await step('chain-unlink-inner', () => fs.unlinkSync(path.join(root, 'ctx/real/inner')));
      await step('chain-edit-after-unlink', () => W(root, 'ctx/real/a.js', 6));
    }
  }),
  // A case variant of a watched folder (case-insensitive file systems only).
  case: () => {
    if (process.platform === 'linux') return receipt({ type: 'skip', scenario: 'case' });
    return scenario('case', {
      state: { contexts: ['CTX'], files: ['Ctx/f.txt'] },
      setup: root => {
        write(root, 'index.js', 'module.exports = require("./Ctx/a.js");', true);
        write(root, 'ctx/a.js', 'module.exports = 1;', true);
        write(root, 'ctx/f.txt', 'f', true);
      },
      run: async ({ root, step }) => {
        await step('case-edit-module', () => W(root, 'ctx/a.js', 2));
        await step('case-edit-file', () => write(root, 'ctx/f.txt', 'f2'));
        await step('case-new-in-context', () => write(root, 'ctx/new.txt', 'n'));
        await step('case-edit-module-variant', () => W(root, 'CTX/a.js', 3));
      }
    });
  },
  // The root spelled through a link or a short name (/tmp on macOS, 8.3 on Windows).
  spelled: () => {
    let base;
    if (process.platform === 'darwin') base = '/tmp';
    else if (win) {
      const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';
      if (fs.existsSync(short)) base = short;
    } else {
      const real = path.join(process.env.TMPDIR, 'c3-real');
      const alias = path.join(process.env.TMPDIR, 'c3-alias');
      fs.mkdirSync(real, { recursive: true });
      if (!fs.existsSync(alias)) fs.symlinkSync(real, alias);
      base = alias;
    }
    if (!base) return receipt({ type: 'skip', scenario: 'spelled' });
    const root = makeRoot('spelled', base);
    return scenario('spelled', {
      root,
      state: { contexts: ['ctx'], files: ['ctx/f.txt'] },
      setup: r => {
        write(r, 'index.js', ctxIndex('./ctx'), true);
        write(r, 'ctx/a.js', 'module.exports = 1;', true);
        write(r, 'ctx/f.txt', 'f', true);
      },
      run: async ({ root, step }) => {
        await step('spelled-edit', () => W(root, 'ctx/a.js', 2));
        await step('spelled-file', () => write(root, 'ctx/f.txt', 'f2'));
        await step('spelled-new-deep', () => W(root, 'ctx/d/e/n.js', 3));
        await step('spelled-remove', () => fs.unlinkSync(path.join(root, 'ctx/f.txt')));
        await step('spelled-recreate', () => write(root, 'ctx/f.txt', 'f3'));
      }
    });
  },
  // Delete and recreate the context root.
  rootcycle: () => scenario('rootcycle', {
    state: { files: ['ctx/sub/f.txt'] },
    setup: root => {
      write(root, 'index.js', ctxIndex('./ctx'), true);
      write(root, 'ctx/a.js', 'module.exports = 1;', true);
      write(root, 'ctx/sub/b.js', 'module.exports = 2;', true);
      write(root, 'ctx/sub/f.txt', 'f', true);
      write(root, 'ext/t/x.js', 'module.exports = 1;', true);
      link(root, 'ext/t', 'ctx/l');
    },
    run: async ({ root, step }) => {
      await step('rc-edit', () => W(root, 'ctx/a.js', 3));
      await step('rc-delete', () => fs.rmSync(path.join(root, 'ctx'), { recursive: true, force: true }));
      await step('rc-recreate', () => W(root, 'ctx/c.js', 5));
      await step('rc-new-sub', () => W(root, 'ctx/sub2/d.js', 6));
      await step('rc-file-back', () => write(root, 'ctx/sub/f.txt', 'f2'));
      await step('rc-relink', () => link(root, 'ext/t', 'ctx/l'));
      await step('rc-edit-ext', () => W(root, 'ext/t/x.js', 7));
      await step('rc-edit-after', () => W(root, 'ctx/c.js', 8));
    }
  }),
  // Retarget a link from one directory to another.
  retarget: () => scenario('retarget', {
    setup: root => {
      write(root, 'index.js', ctxIndex('./ctx'), true);
      write(root, 'ctx/a/x.js', 'module.exports = 1;', true);
      write(root, 'ctx/b/x.js', 'module.exports = 10;', true);
      link(root, 'ctx/a', 'ctx/link');
    },
    run: async ({ root, step }) => {
      await step('rt-edit-a', () => W(root, 'ctx/a/x.js', 2));
      await step('rt-retarget', () => { fs.unlinkSync(path.join(root, 'ctx/link')); link(root, 'ctx/b', 'ctx/link'); });
      await step('rt-edit-b', () => W(root, 'ctx/b/x.js', 11));
      await step('rt-edit-a2', () => W(root, 'ctx/a/x.js', 3));
      await step('rt-new-b', () => W(root, 'ctx/b/y.js', 12));
      await step('rt-back', () => { fs.unlinkSync(path.join(root, 'ctx/link')); link(root, 'ctx/a', 'ctx/link'); });
      await step('rt-edit-a3', () => W(root, 'ctx/a/x.js', 4));
      await step('rt-edit-b2', () => W(root, 'ctx/b/x.js', 13));
    }
  })
};
(async () => {
  receipt({ type: 'identity', watchpack: localRequire('watchpack/package.json').version, pin });
  const only = process.env.C3_ONLY ? process.env.C3_ONLY.split(',') : Object.keys(scenarios);
  for (const name of only) await scenarios[name]();
  receipt({ type: 'done', identity: loadedIdentity() });
})().catch(error => { receipt({ type: 'failure', error: String(error.stack) }); process.exitCode = 1; });
