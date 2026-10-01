import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rspack } from '@rspack/core';
import { closeCompiler } from '@rspack/test-tools/helper/lifecycle';

const kinds = ['file', 'context', 'missing'];

// Observe Watching without wrapping the native adapter's watch method.
function startWatch(compiler) {
  let resolve, reject;
  const nextDelivery = () =>
    new Promise((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
  const firstDelivery = nextDelivery();
  const watching = compiler.watch({ ignored: /.*/ }, (error, stats) => {
    if (error || stats?.hasErrors())
      reject(error || new Error(stats.toString()));
  });
  const watch = watching.watch;
  watching.watch = function (...args) {
    try {
      const result = watch.apply(this, args);
      resolve();
      return result;
    } catch (error) {
      reject(error);
    }
  };
  return { watching, firstDelivery, nextDelivery };
}

export default ['native-iterations', 'object-wrapper'].map((name) => ({
  name,
  description: 'checks initial and subsequent dependency delivery',
  async run() {
    const context = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'native-watch-')),
    );
    let compiler;
    try {
      await fs.writeFile(path.join(context, 'entry.js'), 'export default 1;');
      compiler = rspack({
        context,
        mode: 'development',
        entry: './entry.js',
        experiments: { nativeWatcher: true },
        output: { path: path.join(context, 'dist') },
      });
      const native = compiler.watchFileSystem;
      const counts = [],
        registrations = [],
        snapshots = [];
      let generation = 0;
      compiler.hooks.afterDone.tap('LateDependencies', (stats) => {
        generation++;
        kinds.forEach((kind) =>
          stats.compilation[`${kind}Dependencies`].add(
            path.join(context, `late-${kind}-${generation}`),
          ),
        );
      });
      if (name === 'native-iterations') {
        compiler.hooks.thisCompilation.tap('CountIterations', (compilation) => {
          const build = counts.push(0) - 1;
          kinds.forEach((kind) => {
            const dependencies = compilation[`${kind}Dependencies`];
            const iterator = dependencies[Symbol.iterator];
            dependencies[Symbol.iterator] = function () {
              counts[build]++;
              return iterator.call(this);
            };
          });
        });
        const format = native.formatWatchDependencies;
        native.formatWatchDependencies = function (dependencies) {
          const result = format.call(this, dependencies);
          registrations.push(result);
          return result;
        };
      } else {
        compiler.watchFileSystem = {
          watch(...args) {
            const sets = args.slice(0, 3);
            sets.forEach((set, index) => {
              const expected = path.join(
                context,
                `late-${kinds[index]}-${generation}`,
              );
              assert(set instanceof Set);
              assert(set.has(expected));
            });
            assert(sets[0].has(path.join(context, 'entry.js')));
            snapshots.push(sets);
            return native.watch(...args);
          },
        };
      }
      const session = startWatch(compiler);
      await session.firstDelivery;
      const retained = snapshots[0]?.map((set) => [...set]);
      const delivery = session.nextDelivery();
      session.watching.invalidate();
      await delivery;
      if (name === 'native-iterations') {
        assert.deepEqual(counts, [3, 0]);
        assert(registrations[3][0].includes(path.join(context, 'late-file-2')));
      } else {
        assert.deepEqual(
          snapshots[0].map((set) => [...set]),
          retained,
        );
      }
    } finally {
      if (compiler) await closeCompiler(compiler);
      await fs.rm(context, { recursive: true, force: true, maxRetries: 3 });
    }
  },
}));
