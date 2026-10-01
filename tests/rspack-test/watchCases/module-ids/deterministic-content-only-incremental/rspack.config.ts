import { defineConfig } from '@rspack/cli';

export default defineConfig({
  mode: 'development',
  cache: false,
  incremental: { silent: false },
  devtool: false,
  optimization: {
    moduleIds: 'deterministic',
    chunkIds: 'named',
    concatenateModules: false,
    inlineExports: false,
    mangleExports: false,
    usedExports: false,
    splitChunks: false,
    minimize: false,
  },
  stats: {
    logging: 'verbose',
    loggingDebug: /rspack\.incremental/,
    cachedModules: true,
    groupModulesByAttributes: false,
    groupModulesByCacheStatus: false,
    groupModulesByType: false,
    groupModulesByPath: false,
    groupModulesByExtension: false,
  },
});
