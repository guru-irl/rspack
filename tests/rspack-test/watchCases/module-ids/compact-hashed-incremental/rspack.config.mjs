/** @type {import('@rspack/core').Configuration} */
export default {
  incremental: true,
  cache: { type: 'memory' },
  optimization: {
    moduleIds: 'compact-hashed',
    chunkIds: 'named',
    concatenateModules: false,
  },
  stats: { cachedModules: true },
};
