import fs from 'node:fs';
import path from 'node:path';
import { rspack } from '@rspack/core';

const options = {
  target: 'node',
  mode: 'development',
  devtool: 'cheap-module-source-map',
  optimization: { minimize: false, concatenateModules: false },
  output: {
    filename: 'bundle.js',
    devtoolNamespace: 'cached-line-map',
    pathinfo: false,
    bundlerInfo: { force: false },
  },
};

export default {
  ...options,
  plugins: [
    {
      apply(compiler) {
        let builds = 0;
        compiler.hooks.afterEmit.tapPromise('CheckCachedLineMap', async () => {
          if (++builds !== 2) return;
          const freshPath = path.join(compiler.outputPath, 'fresh');
          const fresh = rspack({
            ...options,
            context: compiler.context,
            entry: './index.js',
            output: { ...options.output, path: freshPath },
          });
          try {
            await new Promise((resolve, reject) => {
              fresh.run((error, stats) => {
                if (error) return reject(error);
                if (stats.hasErrors())
                  return reject(new Error(stats.toString('errors-only')));
                resolve();
              });
            });
            expect(
              fs.readFileSync(
                path.join(compiler.outputPath, 'bundle.js.map'),
                'utf8',
              ),
            ).toBe(
              fs.readFileSync(path.join(freshPath, 'bundle.js.map'), 'utf8'),
            );
          } finally {
            await new Promise((resolve, reject) =>
              fresh.close((error) => (error ? reject(error) : resolve())),
            );
            fs.rmSync(freshPath, { recursive: true, force: true });
          }
        });
      },
    },
  ],
};
