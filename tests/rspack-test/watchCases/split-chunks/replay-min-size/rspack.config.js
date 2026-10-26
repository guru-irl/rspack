module.exports = {
  mode: 'development',
  target: 'node',
  devtool: false,
  output: { chunkFilename: '[name].js' },
  optimization: {
    minimize: false,
    concatenateModules: false,
    splitChunks: {
      experimentalReplay: true,
      chunks: 'all',
      minSize: 1000,
      cacheGroups: {
        default: false,
        defaultVendors: false,
        shared: { test: /shared\.js$/, name: 'shared', minChunks: 2 },
      },
    },
  },
};
