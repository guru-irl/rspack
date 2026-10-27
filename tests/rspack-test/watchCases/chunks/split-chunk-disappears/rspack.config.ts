import { defineConfig } from '@rspack/cli';

export default defineConfig({
  target: 'node',
  output: {
    chunkFilename: '[name].[contenthash].js',
  },
  optimization: {
    splitChunks: {
      chunks: 'all',
      minSize: 0,
      cacheGroups: {
        default: false,
        defaultVendors: false,
        shared: {
          test: /shared\.js$/,
          name: 'selected',
          minChunks: 2,
          minSize: 80,
        },
      },
    },
  },
});
