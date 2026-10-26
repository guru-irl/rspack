module.exports = {
  mode: 'development',
  target: 'node',
  devtool: false,
  output: { filename: 'bundle.js', chunkFilename: '[name].js' },
  optimization: {
    minimize: false,
    splitChunks: {
      experimentalCache: true,
      chunks: 'all',
      minSize: 0,
      cacheGroups: {
        default: false,
        defaultVendors: false,
        sizes: {
          test: (module) =>
            /[\\/]shared\.js$/.test(module.resource || '') &&
            module.size() >= 1000,
          name: 'size-dependent',
          minChunks: 2,
        },
      },
    },
  },
};
