import fs from 'node:fs';
import path from 'node:path';
import { rspack } from '@rspack/core';

const entry = (include) =>
  "import('./m24.js');\n" +
  (include ? "import('./m9.js');\n" : '') +
  "import(/* webpackMode: 'weak' */ './m1.js');\n";

function assets(stats) {
  expect(stats.hasErrors()).toBe(false);
  return Object.fromEntries(
    stats.compilation
      .getAssets()
      .map(({ name, source }) => [
        name,
        Buffer.from(source.source()).toString('utf8'),
      ]),
  );
}

/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
  description:
    'should regenerate a weakly retained module when it rejoins a chunk in watch mode',
  options(context) {
    const root = context.getDist('src');
    fs.mkdirSync(root, { recursive: true });
    const files = {
      'e0.js': entry(true),
      'm9.js': "import './m1.js'; export const m9 = 9;",
      'm24.js':
        "import(/* webpackChunkName: 'gb', webpackFetchPriority: 'high' */ './m22.js'); export const m24 = 24;",
      'm1.js':
        "import(/* webpackChunkName: 'gb' */ './m0.js'); export const m1 = 1;",
      'm22.js': 'export const m22 = 22;',
      'm0.js': 'export const m0 = 0;',
    };
    for (const [file, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, file), source);
    }
    return {
      context: fs.realpathSync(root),
      mode: 'development',
      devtool: false,
      entry: { e0: './e0.js' },
      cache: true,
      incremental: true,
      output: {
        path: context.getDist('output'),
        filename: '[name].js',
        chunkFilename: '[name].[contenthash:8].js',
      },
      optimization: {
        chunkIds: 'deterministic',
        moduleIds: 'named',
        minimize: false,
      },
    };
  },
  async build(context, compiler) {
    const root = compiler.options.context;
    const write = (file, source) => {
      const filename = path.join(root, file);
      fs.writeFileSync(filename, source);
      // Supply exact edits without depending on filesystem notification timing.
      setImmediate(() =>
        compiler.watching.invalidateWithChangesAndRemovals(
          new Set([filename]),
          new Set(),
        ),
      );
    };
    let step = 0;
    const rebuilt = await new Promise((resolve, reject) => {
      const watching = compiler.watch(
        { ignored: /./, aggregateTimeout: 0 },
        (error, stats) => {
          try {
            if (error) throw error;
            const output = assets(stats);
            switch (step++) {
              case 0:
                write('e0.js', entry(false));
                break;
              case 1:
                write(
                  'm24.js',
                  "import(/* webpackChunkName: 'gb' */ './m22.js'); export const m24 = 24;",
                );
                break;
              case 2:
                write('e0.js', entry(true));
                break;
              default:
                watching.close((error) =>
                  error ? reject(error) : resolve(output),
                );
            }
          } catch (error) {
            watching.close(() => reject(error));
          }
        },
      );
    });
    const cold = rspack({
      ...compiler.options,
      cache: false,
      incremental: false,
      plugins: [],
    });
    cold.outputFileSystem = compiler.outputFileSystem;
    try {
      const stats = await new Promise((resolve, reject) => {
        cold.run((error, stats) => (error ? reject(error) : resolve(stats)));
      });
      expect(rebuilt).toEqual(assets(stats));
    } finally {
      await new Promise((resolve, reject) =>
        cold.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
};
