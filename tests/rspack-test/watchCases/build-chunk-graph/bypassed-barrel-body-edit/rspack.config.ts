import { defineConfig } from '@rspack/cli';
import type { Compiler, NormalModule } from '@rspack/core';

export default defineConfig({
  optimization: {
    sideEffects: true,
    splitChunks: false,
  },
  incremental: {
    buildChunkGraph: true,
  },
  module: {
    rules: [{ test: /\.js$/, sideEffects: false }],
  },
  plugins: [
    {
      apply(compiler: Compiler) {
        compiler.hooks.finishMake.tapPromise(
          'RebuildStableResolver',
          async compilation => {
            const resolver = [...compilation.modules].find(module =>
              (module as NormalModule).resource?.endsWith('/resolver.js'),
            );
            if (resolver) {
              await new Promise<void>((resolve, reject) => {
                compilation.rebuildModule(resolver, error => {
                  if (error) reject(error);
                  else resolve();
                });
              });
            }
          },
        );
      },
    },
  ],
});
