import { defineConfig } from '@rspack/cli';

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
});
