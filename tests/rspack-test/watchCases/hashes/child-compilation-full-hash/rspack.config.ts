import path from 'node:path';
import { defineConfig } from '@rspack/cli';

export default defineConfig({
  plugins: [
    (compiler) => {
      compiler.hooks.make.tapAsync('ChildHash', (compilation, callback) => {
        compilation.fileDependencies.add(
          path.resolve(compiler.context, 'child.js'),
        );
        const child = compilation.createChildCompiler(
          'hash-child',
          { filename: 'child.js' },
          [
            new compiler.rspack.EntryPlugin(compiler.context, './child.js', {
              name: 'child',
            }),
          ],
        );
        child.runAsChild((error) => callback(error));
      });
    },
  ],
});
