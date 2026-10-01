import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rspack } from '@rspack/core';
import { closeCompiler } from '@rspack/test-tools/helper/lifecycle';

const kinds = ['file', 'context', 'missing'];
const fixture = import.meta.dirname;

// Observe Watching's delivery, not watchFileSystem.watch: wrapping the latter
// intentionally opts out of the built-in watcher's private capability.
function startWatch(compiler, observe = () => {}) {
  const deliveries = [];
  let waiting;
  let failure;
  const watching = compiler.watch({ ignored: /.*/ }, (error, stats) => {
    if (error || stats?.hasErrors()) {
      failure =
        error || new Error(stats.toString({ all: false, errors: true }));
      waiting?.reject(failure);
      waiting = undefined;
    }
  });
  const watch = watching.watch;
  watching.watch = function (...args) {
    const result = watch.apply(this, args);
    const delivery = observe(args);
    if (waiting) {
      waiting.resolve(delivery);
      waiting = undefined;
    } else {
      deliveries.push(delivery);
    }
    return result;
  };
  return {
    watching,
    nextDelivery() {
      if (failure) return Promise.reject(failure);
      if (deliveries.length) return Promise.resolve(deliveries.shift());
      return new Promise((resolve, reject) => {
        assert.equal(waiting, undefined);
        waiting = { resolve, reject };
      });
    },
  };
}

async function withCompiler(run, nativeWatcher = true) {
  const scratch = path.resolve(
    fixture,
    '../../../../.spider/scratch/task-2/fixtures',
  );
  await fs.mkdir(scratch, { recursive: true });
  const context = await fs.mkdtemp(path.join(scratch, 'watch-'));
  await fs.copyFile(
    path.join(fixture, 'entry.js'),
    path.join(context, 'entry.js'),
  );
  await fs.mkdir(path.join(context, 'context'));
  const compiler = rspack({
    context,
    mode: 'development',
    entry: './entry.js',
    devtool: false,
    experiments: { nativeWatcher },
    output: { path: path.join(context, 'dist') },
  });
  try {
    await run(compiler, context);
  } finally {
    await closeCompiler(compiler);
    await fs.rm(context, { recursive: true, force: true });
  }
}

function countIterations(compiler) {
  const counts = [];
  compiler.hooks.thisCompilation.tap(
    'CountWatchDependencyIterations',
    (compilation) => {
      const count = [0, 0, 0];
      counts.push(count);
      kinds.forEach((kind, index) => {
        const dependencies = compilation[`${kind}Dependencies`];
        const iterator = dependencies[Symbol.iterator];
        dependencies[Symbol.iterator] = function () {
          count[index]++;
          return iterator.call(this);
        };
      });
      compilation.contextDependencies.add(
        path.join(compiler.context, 'context'),
      );
      compilation.missingDependencies.add(
        path.join(compiler.context, 'missing.txt'),
      );
    },
  );
  return counts;
}

export default [
  {
    name: 'native-iterations',
    description: 'reads full membership only for initial native registration',
    async run() {
      await withCompiler(async (compiler) => {
        const counts = countIterations(compiler);
        const session = startWatch(compiler);
        await session.nextDelivery();
        assert.deepEqual(counts, [[1, 1, 1]]);
        for (let cycle = 0; cycle < 2; cycle++) {
          session.watching.invalidate();
          await session.nextDelivery();
        }
        assert.deepEqual(counts.slice(1), [
          [0, 0, 0],
          [0, 0, 0],
        ]);
      });
    },
  },
  {
    name: 'native-restart',
    description:
      'resends owned full membership after closing and restarting native watch',
    async run() {
      await withCompiler(async (compiler, context) => {
        const counts = countIterations(compiler);
        const native = compiler.watchFileSystem;
        const format = native.formatWatchDependencies;
        const registrations = [];
        native.formatWatchDependencies = function (dependencies) {
          const result = format.call(this, dependencies);
          registrations.push(result);
          return result;
        };
        const first = startWatch(compiler);
        await first.nextDelivery();
        await new Promise((resolve) => first.watching.close(resolve));
        const second = startWatch(compiler);
        await second.nextDelivery();
        assert.deepEqual(counts, [
          [1, 1, 1],
          [1, 1, 1],
        ]);
        for (const offset of [0, 3]) {
          assert(
            registrations[offset][0].includes(path.join(context, 'entry.js')),
          );
          assert(
            registrations[offset + 1][0].includes(
              path.join(context, 'context'),
            ),
          );
          assert(
            registrations[offset + 2][0].includes(
              path.join(context, 'missing.txt'),
            ),
          );
        }
      });
    },
  },
  ...['object-wrapper', 'method-wrapper', 'node'].map((variant) => ({
    name: variant,
    description: `keeps full owned dependency Sets on every ${variant} delivery`,
    async run() {
      await withCompiler(async (compiler, context) => {
        const native = compiler.watchFileSystem;
        const watch = native.watch;
        const retained = [];
        let generation = 0;
        compiler.hooks.thisCompilation.tap('Generation', () => generation++);
        compiler.hooks.afterDone.tap('LateOwnedDependencies', (stats) => {
          kinds.forEach((kind) => {
            stats.compilation[`${kind}Dependencies`].add(
              path.join(context, `${kind}-${generation}`),
            );
          });
        });
        function wrappedWatch(...args) {
          const snapshots = args.slice(0, 3);
          snapshots.forEach((dependencies, index) => {
            assert(dependencies instanceof Set);
            assert(dependencies.size > 0);
            assert(
              dependencies.has(
                path.join(context, `${kinds[index]}-${generation}`),
              ),
            );
            assert(dependencies.added instanceof Set);
            assert(dependencies.removed instanceof Set);
          });
          assert(snapshots[0].has(path.join(context, 'entry.js')));
          retained.push(snapshots);
          return watch.apply(native, args);
        }
        if (variant === 'method-wrapper') native.watch = wrappedWatch;
        else compiler.watchFileSystem = { watch: wrappedWatch };
        const session = startWatch(compiler);
        await session.nextDelivery();
        for (let cycle = 0; cycle < 2; cycle++) {
          session.watching.invalidate();
          await session.nextDelivery();
        }
        await closeCompiler(compiler);
        assert.equal(retained.length, 3);
        retained.forEach((snapshots, index) => {
          kinds.forEach((kind, kindIndex) => {
            const dependencies = snapshots[kindIndex];
            assert(
              dependencies.has(path.join(context, `${kind}-${index + 1}`)),
            );
            assert(
              !dependencies.has(path.join(context, `${kind}-${index + 2}`)),
            );
            assert.notEqual(dependencies, retained[(index + 1) % 3][kindIndex]);
            // Full iteration remains safe even after the native compiler closes.
            assert(
              [...dependencies].includes(
                path.join(context, `${kind}-${index + 1}`),
              ),
            );
          });
        });
      }, variant !== 'node');
    },
  })),
  {
    name: 'coalesced-deltas',
    description:
      'keeps additions and removals from a skipped build in native delivery',
    async run() {
      await withCompiler(async (compiler, context) => {
        await fs.copyFile(
          path.join(fixture, 'dependency-loader.cjs'),
          path.join(context, 'dependency-loader.cjs'),
        );
        await fs.writeFile(
          path.join(context, 'entry.js'),
          "import './retained.js';",
        );
        await fs.writeFile(
          path.join(context, 'retained.js'),
          'export default "old";',
        );
        for (const phase of ['old', 'new']) {
          await fs.writeFile(path.join(context, `${phase}.txt`), phase);
          await fs.mkdir(path.join(context, `${phase}-context`));
        }
        compiler.options.module.rules.push({
          test: /retained\.js$/,
          use: [path.join(context, 'dependency-loader.cjs')],
        });
        let builds = 0;
        let session;
        compiler.hooks.make.tap('CoalesceWatchBuild', () => {
          builds++;
          if (builds === 2) session.watching.invalidate();
        });
        session = startWatch(compiler, (args) =>
          args.map((dependencies) => ({
            added: [...dependencies.added],
            removed: [...dependencies.removed],
          })),
        );
        await session.nextDelivery();
        await fs.writeFile(
          path.join(context, 'retained.js'),
          'export default "new";',
        );
        session.watching.invalidateWithChangesAndRemovals(
          new Set([path.join(context, 'retained.js')]),
        );
        const delivered = await session.nextDelivery();
        assert.equal(builds, 3);
        for (const [index, suffix] of [
          '.txt',
          '-context',
          '-missing',
        ].entries()) {
          assert(
            delivered[index].added.includes(path.join(context, `new${suffix}`)),
          );
          assert(
            delivered[index].removed.includes(
              path.join(context, `old${suffix}`),
            ),
          );
        }
      });
    },
  },
];
