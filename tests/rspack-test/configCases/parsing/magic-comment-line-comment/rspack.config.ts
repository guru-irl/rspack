import { defineConfig } from '@rspack/cli';

export default defineConfig({
  target: 'node',
  output: {
    chunkFilename: '[name].js',
  },
  optimization: {
    chunkIds: 'named',
  },
  module: {
    rules: [
      {
        test: /\.tsx$/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            target: 'es2022',
          },
        },
      },
    ],
  },
});
