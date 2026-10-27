import fs from 'node:fs';
import path from 'node:path';

const NAME = 'native-watcher-absent-parent';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** @type {import("@rspack/test-tools").TCompilerCaseConfig} */
export default {
  description:
    'should recover a retained absent file after its parent is removed',
  options(context) {
    const root = context.getDist(NAME);
    fs.rmSync(root, { recursive: true, force: true });
    const source = path.join(root, 'source');
    const retained = path.join(root, 'retained', 'deep', 'parent', 'value.txt');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(path.dirname(retained), { recursive: true });
    const entry = path.join(source, 'index.js');
    fs.writeFileSync(entry, 'module.exports = 1;\n');
    fs.writeFileSync(retained, 'original');
    const state = {
      retained,
      entry,
      output: path.join(root, 'dist', 'retained.txt'),
      barrier: path.join(root, 'barrier'),
      hold: false,
      entered: deferred(),
      released: deferred(),
      classified: deferred(),
    };
    context.setValue('state', state);
    return {
      context: source,
      mode: 'development',
      devtool: false,
      target: 'node',
      entry: './index.js',
      output: { path: path.join(root, 'dist') },
      experiments: { nativeWatcher: true },
      plugins: [
        (compiler) => {
          compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
            compilation.fileDependencies.add(retained);
            compilation.emitAsset(
              'retained.txt',
              new compiler.webpack.sources.RawSource(
                fs.existsSync(retained) ? fs.readFileSync(retained) : 'absent',
              ),
            );
          });
          compiler.hooks.afterCompile.tapPromise(NAME, async () => {
            if (state.hold) {
              state.hold = false;
              state.entered.resolve();
              await state.released.promise;
            }
          });
        },
      ],
    };
  },
  async build(context, compiler) {
    compiler.outputFileSystem = fs;
    const state = context.getValue('state');
    const builds = [];
    const waiters = [];
    const timers = new Set();
    const bounded = (promise, label) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          10000,
        );
        timers.add(timer);
        promise.then((value) => {
          clearTimeout(timer);
          timers.delete(timer);
          resolve(value);
        }, reject);
      });
    const nextBuild = (index) =>
      bounded(
        builds.length > index
          ? Promise.resolve(builds[index])
          : new Promise((resolve) => {
              waiters[index] = resolve;
            }),
        'a rebuild',
      );
    const watching = compiler.watch(
      {
        aggregateTimeout: 50,
        ignored: (entry) => {
          if (entry === state.barrier) {
            state.classified.resolve();
            return true;
          }
          return false;
        },
      },
      (error, stats) => {
        const result = {
          error:
            error || (stats.hasErrors() ? new Error(stats.toString()) : null),
          content: fs.existsSync(state.output)
            ? fs.readFileSync(state.output, 'utf8')
            : undefined,
        };
        const index = builds.push(result) - 1;
        waiters[index]?.(result);
      },
    );
    const check = (result, content) => {
      if (result.error) throw result.error;
      expect(result.content).toBe(content);
    };
    try {
      check(await nextBuild(0), 'original');
      fs.unlinkSync(state.retained);
      check(await nextBuild(1), 'absent');
      // This build can start only after the absent watch application is active.
      state.hold = true;
      fs.writeFileSync(state.entry, 'module.exports = 2;\n');
      await bounded(state.entered.promise, 'the held build');
      fs.rmSync(path.dirname(state.retained), { recursive: true });
      compiler.watchFileSystem.watcher._onRemove(path.dirname(state.retained));
      compiler.watchFileSystem.watcher._onChange(state.barrier);
      await bounded(state.classified.promise, 'the removal event barrier');
      fs.mkdirSync(path.dirname(state.retained), { recursive: true });
      fs.writeFileSync(state.retained, 'restored');
      state.released.resolve();
      check(await nextBuild(2), 'absent');
      check(await nextBuild(3), 'restored');
      context.setValue('restored', builds[3].content);
    } finally {
      state.released.resolve();
      for (const timer of timers) clearTimeout(timer);
      await new Promise((resolve, reject) =>
        watching.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  async check({ context }) {
    expect(context.getValue('restored')).toBe('restored');
  },
};
