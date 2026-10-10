import assert from 'node:assert/strict';
import { defineConfig, definePlugin } from '@rspack/cli';
import type { Chunk } from '@rspack/core';

export default defineConfig({
  experiments: { asyncWebAssembly: true },
  optimization: { minimize: false, moduleIds: 'natural' },
  output: { filename: 'middle.js', webassemblyModuleFilename: '[id].wasm' },
  module: {
    rules: [
      { test: /\.wat$/, type: 'webassembly/async', loader: 'wast-loader' },
    ],
  },
  plugins: [
    definePlugin({
      name: 'ChunkCollectionSnapshots',
      apply(compiler) {
        compiler.hooks.compilation.tap(
          'ChunkCollectionSnapshots',
          (compilation) => {
            const hook = compilation.hooks.processAssets;
            assert.equal(hook.isUsed(), false);
            let chunk: Chunk;
            let calls = 0;
            let restore: () => void;
            hook.tap({ name: 'snapshot', stage: 0 }, () => {
              chunk = [...compilation.chunks].find((c) => c.files.size >= 3)!;
              assert.ok(
                chunk,
                'the fixture must emit at least three files in one chunk',
              );
              const proto = Object.getPrototypeOf(chunk);
              const descriptor = Object.getOwnPropertyDescriptor(
                proto,
                '_files',
              )!;
              Object.defineProperty(proto, '_files', {
                ...descriptor,
                get(this: Chunk) {
                  calls++;
                  return descriptor.get!.call(this);
                },
              });
              restore = () =>
                Object.defineProperty(proto, '_files', descriptor);
              try {
                const first = chunk.files as Set<string>;
                const expected = [...first];
                const before = calls;
                const second = chunk.files;
                assert.equal(
                  calls,
                  before,
                  'a repeated files read in the same tap must avoid native materialization',
                );
                assert.notEqual(first, second);
                first.clear();
                first.add('not-an-asset');
                assert.deepEqual([...chunk.files], expected);
                const original = expected[0];
                compilation.renameAsset(original, 'zzzz-renamed.wasm');
                const renamed = expected
                  .filter((f) => f !== original)
                  .concat('zzzz-renamed.wasm')
                  .sort();
                assert.deepEqual([...chunk.files], renamed);
                assert.equal(renamed.length, expected.length);
                assert.notEqual(
                  renamed.indexOf('zzzz-renamed.wasm'),
                  expected.indexOf(original),
                );
                compilation.deleteAsset('zzzz-renamed.wasm');
                assert.deepEqual(
                  [...chunk.files],
                  renamed.filter((f) => f !== 'zzzz-renamed.wasm'),
                );
                const groups = chunk.groupsIterable as Set<
                  (typeof compilation.chunkGroups)[number]
                >;
                const groupValues = [...groups];
                groups.clear();
                assert.deepEqual([...chunk.groupsIterable], groupValues);
                const group = groupValues[0];
                const chunks = group.chunks;
                const chunkValues = chunks.slice();
                chunks.length = 0;
                assert.deepEqual(group.chunks, chunkValues);
                assert.notEqual(group.chunks, group.chunks);
              } catch (error) {
                restore();
                throw error;
              }
            });
            hook.tap({ name: 'next-scope', stage: 1 }, () => {
              const before = calls;
              void chunk.files;
              assert.ok(
                calls > before,
                'a later tap must begin without a snapshot',
              );
              const materialized = calls;
              void chunk.files;
              assert.equal(calls, materialized);
            });
            hook.tapPromise({ name: 'promise-scope', stage: 2 }, async () => {
              void chunk.files;
              const prefix = calls;
              void chunk.files;
              assert.equal(calls, prefix);
              await Promise.resolve();
              const before = calls;
              void chunk.files;
              void chunk.files;
              assert.equal(
                calls,
                before + 2,
                'promise continuations must not admit snapshots',
              );
            });
            compilation.hooks.afterProcessAssets.tap('outside-scope', () => {
              try {
                const before = calls;
                void chunk.files;
                void chunk.files;
                assert.equal(
                  calls,
                  before + 2,
                  'reads outside a tap must not admit snapshots',
                );
              } finally {
                restore();
              }
            });
          },
        );
      },
    }),
  ],
});
