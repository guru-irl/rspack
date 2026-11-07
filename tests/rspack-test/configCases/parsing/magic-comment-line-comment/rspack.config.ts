import { defineConfig } from '@rspack/cli';

export default defineConfig({
  target: 'node',
  output: {
    chunkFilename: '[name].js',
    clean: true,
  },
  optimization: {
    chunkIds: 'named',
  },
  module: {
    parser: {
      javascript: {
        commonjsMagicComments: true,
      },
    },
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
