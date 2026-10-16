'use strict';
// Scratch benchmark only. Generate/run on Linux, never on the Mac.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createRequire } = require('node:module');
const root = __dirname;
const req = createRequire(path.join(root, 'toolchain/package.json'));
const { rspack } = req(process.env.CORE_PACKAGE || '@rspack-canary/core');
const trials = Number(process.env.TRIALS || 5);
const count = Number(process.env.SOURCE_COUNT || 10000);
const variants = Math.floor(count * 0.9);
const devtool = process.env.DEVTOOL === 'eval' ? 'eval' : false;
const tag = process.env.BENCH_TAG || devtool || 'plain';
const dataDir = path.join(root, 'data', tag);
fs.mkdirSync(dataDir, { recursive: true });
const allRows = [];
const output = path.join(dataDir, 'results.jsonl');
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
const component = (i, edit = 0) => `export default function Component${i}(props) { return <section data-index={${i}} data-edit={${edit}}><h2>Component ${i}</h2><span>{props.value}</span></section>; }\n`;
const file = i => `Component${String(i).padStart(5, '0')}.jsx`;
function entrySource(extra) {
  const imports = [], names = [];
  for (let i = 0; i < count; i++) {
    imports.push(`import C${i} from './src/${file(i)}';`);
    names.push(`C${i}`);
  }
  for (let i = 0; i < variants; i++) {
    imports.push(`import Q${i} from './src/${file(i)}?variant';`);
    names.push(`Q${i}`);
  }
  for (let i = 0; i < extra; i++) {
    imports.push(`import L${i} from './leaves/Leaf${i}.js';`);
    names.push(`L${i}`);
  }
  return imports.join('\n') + `\nglobalThis.components = [${names.join(',')}];\n`;
}
function prepare(fixture) {
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'leaves'), { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(fixture, 'src', file(i)), component(i));
  fs.writeFileSync(path.join(fixture, 'index.jsx'), entrySource(0));
}
function literalMetrics(js) {
  // Exclude path-info comments, count literal module-ID arguments only.
  // The fixture has no user strings resembling compiler require expressions.
  const decoded = js.replace(/eval\(("(?:\\.|[^"\\])*")\)/g, (_, literal) => JSON.parse(literal));
  const stripped = decoded.replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = [...stripped.matchAll(/__webpack_require__\(\s*("(?:\\.|[^"\\])*"|[0-9]+)\s*\)/g)];
  const hist = {};
  let tokenBytes = 0, idBytes = 0;
  for (const m of refs) {
    const value = String(JSON.parse(m[1]));
    tokenBytes += Buffer.byteLength(m[1]);
    idBytes += Buffer.byteLength(value);
    hist[Buffer.byteLength(m[1])] = (hist[Buffer.byteLength(m[1])] || 0) + 1;
  }
  return { references: refs.length, tokenBytes, idBytes, tokenBytesPerReference: tokenBytes / refs.length, idBytesPerReference: idBytes / refs.length, tokenLengthHistogram: hist };
}
function flatten(modules) {
  const out = [];
  for (const m of modules || []) {
    if (m.identifier) out.push(m);
    if (m.modules) out.push(...flatten(m.modules));
    if (m.children) out.push(...flatten(m.children));
  }
  return out;
}
async function run(arm, trial) {
  const fixture = path.join(root, 'fixture');
  prepare(fixture);
  const compiler = rspack({
    context: fixture,
    mode: 'development', target: 'web', devtool,
    entry: './index.jsx',
    cache: true,
    experiments: { incremental: { silent: false } },
    resolve: { modules: [path.join(root, 'toolchain/node_modules')] },
    output: { path: path.join(root, 'emitted', `${tag}-${arm}-${trial}`), filename: 'main.js', pathinfo: true, clean: true },
    optimization: { moduleIds: arm, chunkIds: 'named', minimize: false, concatenateModules: false },
    module: { rules: [{ test: /\.jsx$/, use: { loader: 'builtin:swc-loader', options: { jsc: { target: 'es2020', parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic', development: true } } } } } }] },
    infrastructureLogging: { level: 'error' },
  });
  // Use the public watchFileSystem interface, but supply one explicit change
  // notification per edit. This avoids treating duplicate native fs events as
  // separate benchmark scenarios. Compilation itself still runs in watch mode.
  let notify = null;
  compiler.watchFileSystem = {
    watch(_files, _dirs, _missing, _start, _options, callback) {
      notify = callback;
      return {
        close() {}, pause() {},
        getInfo() { return { changes: new Set(), removals: new Set(), fileTimeInfoEntries: new Map(), contextTimeInfoEntries: new Map() }; },
      };
    },
  };
  let start = 0;
  compiler.hooks.watchRun.tap('ScratchBenchmarkClock', () => { start = performance.now(); });
  let previous = null, initial = null, step = 0, watching;
  const names = ['initial', 'warmup', 'content-1', 'content-2', 'content-3', 'content-4', 'content-5', 'add10', 'add1000'];
  if (trial === 0) names.push('insert-first');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out ${arm} trial ${trial}, step ${step}`)), 180000);
    let finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      const close = () => compiler.close(err => error || err ? reject(error || err) : resolve());
      if (watching) watching.close(close); else close();
    }
    watching = compiler.watch({ aggregateTimeout: 30 }, (error, stats) => {
      const elapsedMs = performance.now() - start;
      if (error) return finish(error);
      if (!stats || stats.hasErrors()) return finish(new Error(stats?.toString({ all: false, errors: true }) || 'No stats'));
      if (step >= names.length) return finish(new Error('Unexpected extra watch rebuild'));
      try {
        const json = stats.toJson({ all: false, ids: true, modules: true, cachedModules: true, runtimeModules: true, nestedModules: true, timings: true, errors: true, warnings: true, logging: 'verbose', loggingDebug: [/^rspack\.(Compilation|incremental)/], groupModulesByAttributes: false, groupModulesByCacheStatus: false, groupModulesByExtension: false, groupModulesByLayer: false, groupModulesByPath: false, groupModulesByType: false, groupModulesByEmitStatus: false });
        const modules = flatten(json.modules).filter(m => m.moduleType !== 'runtime');
        const ids = new Map(modules.filter(m => m.id !== null && m.id !== undefined).map(m => [m.identifier, m.id]));
        if (new Set(ids.values()).size !== ids.size) {
          const buckets = new Map();
          for (const m of modules) if (m.id !== null && m.id !== undefined) {
            const bucket = buckets.get(m.id) || [];
            bucket.push({ identifier: m.identifier, type: m.moduleType, id: m.id });
            buckets.set(m.id, bucket);
          }
          throw new Error('Duplicate module IDs: ' + JSON.stringify([...buckets].filter(([, items]) => items.length > 1).slice(0, 8)));
        }
        if (step === 0 && ids.size < count + variants) throw new Error(`Incomplete module stats: ${ids.size}`);
        const expectedIds = initial ? initial.size + (step === 7 ? 10 : step === 8 ? 1010 : step === 9 ? 1011 : 0) : ids.size;
        if (ids.size !== expectedIds) throw new Error(`Wrong topology for ${names[step]}: expected ${expectedIds}, got ${ids.size}`);
        const changed = previous ? [...previous].filter(([key, id]) => ids.has(key) && ids.get(key) !== id) : [];
        const common = previous ? [...previous.keys()].filter(key => ids.has(key)).length : 0;
        const changedInitial = initial ? [...initial].filter(([key, id]) => ids.has(key) && ids.get(key) !== id) : [];
        const assets = stats.compilation.getAssets().filter(a => a.name.endsWith('.js'));
        const sources = assets.map(a => { try { return String(a.source.source()); } catch { return fs.readFileSync(path.join(compiler.options.output.path, a.name), 'utf8'); } });
        const totalJsBytes = sources.reduce((n, s) => n + Buffer.byteLength(s), 0);
        const metrics = literalMetrics(sources.join('\n'));
        const row = { arm, trial, scenario: names[step], elapsedMs, statsTimeMs: json.time, modules: modules.length, idModules: ids.size, codeGenerated: modules.filter(m => m.codeGenerated).length, built: modules.filter(m => m.built).length, commonExisting: common, changedExisting: changed.length, churnFraction: common ? changed.length / common : 0, changedSinceInitial: changedInitial.length, totalJsBytes, ...metrics, warnings: json.warnings, logging: json.logging };
        fs.appendFileSync(output, JSON.stringify(row) + '\n');
        allRows.push(row);
        console.log(JSON.stringify(row));
        if (!initial) initial = new Map(ids);
        if (trial === 0) {
          fs.writeFileSync(path.join(dataDir, `${arm}-${names[step]}-ids.json`), JSON.stringify([...ids]));
          fs.writeFileSync(path.join(dataDir, `${arm}-${names[step]}-churn.json`), JSON.stringify(changed));
          if (step === 0) fs.writeFileSync(path.join(dataDir, `${arm}-initial-excerpt.txt`), sources[0].slice(0, 12000));
        }
        previous = ids;
        step++;
        if (step === names.length) return finish();
        setImmediate(() => {
          try {
            const changed = new Set();
            function write(filename, contents) { fs.writeFileSync(filename, contents); changed.add(filename); }
            if (step <= 6) {
              write(path.join(fixture, 'src', file(0)), component(0, step));
            } else if (step === 9) {
              write(path.join(fixture, 'leaves', 'Inserted.js'), 'export default 99999;\n');
              write(path.join(fixture, 'index.jsx'), "import Inserted from './leaves/Inserted.js';\n" + entrySource(1010) + '\nglobalThis.components.push(Inserted);\n');
            } else {
              const extra = step === 7 ? 10 : 1010;
              for (let i = step === 7 ? 0 : 10; i < extra; i++) write(path.join(fixture, 'leaves', `Leaf${i}.js`), `export default ${i};\n`);
              write(path.join(fixture, 'index.jsx'), entrySource(extra));
            }
            if (!notify) throw new Error('Watch callback was not registered');
            compiler.inputFileSystem.purge([...changed]);
            notify(null, new Map(), new Map(), changed, new Set());
          } catch (e) { finish(e); }
        });
      } catch (e) { finish(e); }
    });
  });
}
(async () => {
  const arms = ['deterministic', 'named', 'hashed', 'compact-hashed'];
  const env = { at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, cpus: require('node:os').cpus().length, core: req(`${process.env.CORE_PACKAGE || '@rspack-canary/core'}/package.json`), trials, count, variants, devtool };
  fs.writeFileSync(path.join(dataDir, 'environment.json'), JSON.stringify(env, null, 2));
  // Rotate arms per block to avoid assigning thermal/load trends to one strategy.
  for (let trial = 0; trial < trials; trial++) {
    for (let k = 0; k < arms.length; k++) await run(arms[(trial + k) % arms.length], trial);
  }
  fs.writeFileSync(path.join(dataDir, 'complete.json'), JSON.stringify({ rows: allRows.length, at: new Date().toISOString() }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
