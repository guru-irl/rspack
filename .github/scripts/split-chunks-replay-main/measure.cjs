const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const { hash, identity, memory } = require('./native-identity.cjs');
const root = path.resolve(process.env.FIXTURE_ROOT);
const results = path.resolve(process.env.RESULT_DIR);
const native = fs.realpathSync(process.env.RSPACK_BINDING);
const enabled = process.env.RSPACK_SPLIT_CHUNKS_REPLAY === '1';
const hmr = process.env.MEASURE_HMR === '1';
const labels = [
  'cold',
  'content-1',
  'content-2',
  'content-3',
  'content-4',
  'content-5',
  'topology',
];
const originalFile = path.join(root, 'src/g0/m0.js');
const addedFile = path.join(root, 'src/g0/added-module.js');
const original = fs.readFileSync(originalFile);
assert(!fs.existsSync(addedFile));
assert.equal(hash(native), process.env.EXPECTED_NATIVE_SHA);
fs.mkdirSync(results, { recursive: true });

(async () => {
  const core = await import(
    pathToFileURL(path.resolve(process.env.CORE_ENTRY)).href
  );
  const { rspack } = core;
  globalThis.loaderCalls = { noop: 0, ast: 0, rewrite: 0 };
  const callbacks = { test: 0, name: 0, chunks: 0 };
  const compiler = rspack({
    mode: 'development',
    context: root,
    entry: './entry.js',
    target: 'node',
    cache: false,
    devtool: 'cheap-module-source-map',
    incremental: { silent: false },
    plugins: hmr ? [new core.HotModuleReplacementPlugin()] : [],
    output: {
      path: path.join(root, 'out'),
      filename: '[name].cjs',
      chunkFilename: '[name].[id].cjs',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'builtin:swc-loader',
            options: { jsc: { parser: { syntax: 'typescript' } } },
          },
        },
        { test: /[\\/]m\d*0\.js$/, use: path.join(root, 'ast.cjs') },
        {
          test: /[\\/]m(?:\d*(?:05|25|45|65|85)|5)\.js$/,
          use: path.join(root, 'rewrite.cjs'),
        },
        {
          test: /\.[jt]s$/,
          enforce: 'post',
          use: {
            loader: path.join(root, 'noop.cjs'),
            options: { generic: true },
          },
        },
      ],
    },
    optimization: {
      minimize: false,
      concatenateModules: false,
      usedExports: false,
      moduleIds: 'deterministic',
      chunkIds: 'deterministic',
      splitChunks: {
        chunks(chunk) {
          callbacks.chunks++;
          return true;
        },
        minSize: 0,
        cacheGroups: {
          default: false,
          defaultVendors: false,
          shared: {
            type: 'javascript/auto',
            test(module) {
              callbacks.test++;
              return /[\\/]src[\\/]g\d+[\\/]/.test(module.resource || '');
            },
            name(module, chunks, key) {
              callbacks.name++;
              const group = (module.resource || '').match(/[\\/]g(\d+)[\\/]/);
              return group ? 'group-' + group[1] : 'shared';
            },
            enforce: true,
            minChunks: 1,
          },
        },
      },
    },
  });
  const nativeIdentity = identity();
  let notify;
  compiler.watchFileSystem = {
    watch(_files, _dirs, _missing, _start, _options, callback) {
      notify = callback;
      return {
        close() {},
        pause() {},
        getInfo() {
          return {
            changes: new Set(),
            removals: new Set(),
            fileTimeInfoEntries: new Map(),
            contextTimeInfoEntries: new Map(),
          };
        },
      };
    },
  };
  let step = 0;
  const rows = [];
  let previousCallbacks = { ...callbacks };
  let previousLoaderCalls = 0;
  let rebuildStart = performance.now();
  let rebuildCpu = process.cpuUsage();
  const restore = () => {
    fs.writeFileSync(originalFile, original);
    if (fs.existsSync(addedFile)) fs.unlinkSync(addedFile);
  };
  process.on('exit', restore);
  const watching = compiler.watch({}, (error, stats) => {
    if (error || !stats || stats.hasErrors())
      throw error || Error(stats?.toString({ all: false, errors: true }));
    const wallMs = performance.now() - rebuildStart;
    const cpu = process.cpuUsage(rebuildCpu);
    const label = labels[step];
    assert(label, 'Unexpected watch rebuild');
    const json = stats.toJson({
      all: false,
      chunks: true,
      warnings: true,
      logging: 'verbose',
      loggingDebug: [/^rspack\.SplitChunksPlugin/],
    });
    const entries = json.logging?.['rspack.SplitChunksPlugin']?.entries || [];
    const replay = entries
      .filter((entry) => entry.message.startsWith('replay:'))
      .map((entry) => entry.message);
    if (enabled)
      assert.equal(
        replay.length,
        1,
        'Expected one replay decision per compilation',
      );
    else assert.deepEqual(replay, [], 'Replay OFF must not add log lines');
    const hit = enabled && step > 0 && step < 6;
    if (enabled)
      assert(
        replay[0].includes(hit ? 'replay: replayed ' : 'replay: full run ('),
        replay[0],
      );
    if (enabled && step === 0)
      assert(replay[0].includes('no record'), replay[0]);
    if (enabled && step === 6)
      assert(replay[0].includes('inputs changed'), replay[0]);
    const delta = Object.fromEntries(
      Object.entries(callbacks).map(([key, value]) => [
        key,
        value - previousCallbacks[key],
      ]),
    );
    previousCallbacks = { ...callbacks };
    if (hit) {
      assert.equal(delta.test, 0, 'Replay must skip cache-group tests');
      assert.equal(delta.name, 0, 'Replay must skip cache-group names');
    } else
      for (const value of Object.values(delta))
        assert(value > 0, 'A full run must execute each callback selector');
    const processCacheGroups = entries
      .filter((entry) => entry.message.startsWith('process cache groups:'))
      .map((entry) => entry.message);
    if (hit) assert.equal(processCacheGroups.length, 0);
    else assert.equal(processCacheGroups.length, 1);
    const chunkGraphLog = (json.logging?.['rspack.Compilation']?.entries || [])
      .filter((entry) => /chunk graph/i.test(entry.message))
      .map((entry) => entry.message);
    const row = {
      step: label,
      chunkGraphLog,
      splitChunksLog: entries.map((entry) => ({
        type: entry.type,
        message: entry.message,
      })),
      statsHash: stats.hash,
      replay: replay[0] ?? null,
      processCacheGroups,
      callbacks: delta,
      loaderCalls: { ...globalThis.loaderCalls },
      chunkCount: json.chunks.length,
      warnings: json.warnings || [],
      wallMs,
      cpu,
      afterBuild: memory(),
    };
    if (step === 0) assert.equal(globalThis.loaderCalls.noop, 60701);
    else
      assert(
        globalThis.loaderCalls.noop > previousLoaderCalls,
        'Each edit must rebuild a module',
      );
    previousLoaderCalls = globalThis.loaderCalls.noop;
    if (process.env.COPY_OUTPUTS !== '0')
      fs.cpSync(path.join(root, 'out'), path.join(results, label), {
        recursive: true,
      });
    rows.push(row);
    setImmediate(() => {
      if (global.gc) global.gc();
      setImmediate(() => {
        row.steady = memory();
        console.log(JSON.stringify(row));
        if (step++ < labels.length - 1) {
          const content = [
            original,
            Buffer.from('\nmodule.exports += ' + step + ';\n'),
          ];
          const changed = [originalFile];
          if (step === 6) {
            fs.writeFileSync(addedFile, 'module.exports = 900001;\n');
            changed.push(addedFile);
            content.push(
              Buffer.from(
                '\nimport("./added-module.js").then(value => { globalThis.addedFixtureValue = value.default; });\n',
              ),
            );
          }
          fs.writeFileSync(originalFile, Buffer.concat(content));
          compiler.inputFileSystem.purge(changed);
          assert.equal(typeof notify, 'function');
          rebuildStart = performance.now();
          rebuildCpu = process.cpuUsage();
          notify(null, new Map(), new Map(), new Set(changed), new Set());
        } else {
          watching.close((error) => {
            if (error) throw error;
            compiler.close((error) => {
              if (error) throw error;
              restore();
              fs.writeFileSync(
                path.join(results, 'builds.json'),
                JSON.stringify(
                  { nativeIdentity, hmr, rows, finalMemory: memory() },
                  null,
                  2,
                ) + '\n',
              );
            });
          });
        }
      });
    });
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
