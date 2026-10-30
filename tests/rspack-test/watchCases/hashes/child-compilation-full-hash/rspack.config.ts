import path from 'node:path';
import { defineConfig } from '@rspack/cli';
import type { Compiler } from '@rspack/core';

export default defineConfig({
  devtool: false,
  incremental: { silent: true },
  optimization: { moduleIds: 'natural', chunkIds: 'natural' },
  plugins: [
    (compiler: Compiler) => {
      for (const name of ['first', 'second']) {
        compiler.hooks.make.tapAsync(
          `ChildHash-${name}`,
          (compilation, callback) => {
            compilation.fileDependencies.add(
              path.resolve(compiler.context, `${name}.js`),
            );
            const child = compilation.createChildCompiler(
              name,
              { filename: `${name}.js` },
              [
                new compiler.rspack.EntryPlugin(
                  compiler.context,
                  `./${name}.js`,
                  { name: 'child' },
                ),
              ],
            );
            child.runAsChild((error) => callback(error));
          },
        );
      }
    },
  ],
});
