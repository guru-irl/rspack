const path = require('path');
module.exports = {
  entry: { main: './index.js' },
  mode: 'development',
  target: 'node',
  devtool: false,
  optimization: {
    minimize: false,
    concatenateModules: false,
    splitChunks: {
      experimentalReplay: true,
      minSize: 0,
      cacheGroups: {
        default: false,
        defaultVendors: false,
        shared: {
          test: (module) => /shared\.js$/.test(module.resource || ''),
          name: () => 'shared',
          chunks: (chunk) => chunk.name !== 'excluded',
          minChunks: 2,
        },
      },
    },
  },
  plugins: [
    {
      apply(compiler) {
        compiler.hooks.thisCompilation.tap('ReplayLog', (compilation) => {
          compilation.hooks.processAssets.tap(
            { name: 'ReplayLog', stage: 5000 },
            () => {
              const logging = compilation
                .getStats()
                .toJson({ all: false, logging: 'info' }).logging;
              const entries =
                logging?.['rspack.SplitChunksPlugin']?.entries || [];
              const lines = entries
                .map((entry) => entry.message)
                .filter((message) => message.startsWith('replay:'));
              compilation.emitAsset(
                'replay-log.json',
                new compiler.rspack.sources.RawSource(JSON.stringify(lines)),
              );
              const placement = Object.fromEntries(
                Array.from(compilation.chunks, (chunk) => [
                  chunk.name,
                  Array.from(
                    compilation.chunkGraph.getChunkModulesIterable(chunk),
                  )
                    .filter((module) => module.resource)
                    .map((module) =>
                      path
                        .relative(compiler.context, module.resource)
                        .replaceAll('\\', '/'),
                    )
                    .sort(),
                ]),
              );
              compilation.emitAsset(
                'replay-map.json',
                new compiler.rspack.sources.RawSource(
                  JSON.stringify(placement),
                ),
              );
            },
          );
        });
      },
    },
  ],
};
