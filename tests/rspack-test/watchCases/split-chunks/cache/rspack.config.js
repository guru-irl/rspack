const path = require('path');
const calls = { test: 0, name: 0, chunks: 0 };
let previousCalls = { ...calls };
module.exports = {
  entry: { main: './index.js' },
  mode: 'development',
  target: 'node',
  devtool: false,
  optimization: {
    minimize: false,
    concatenateModules: false,
    splitChunks: {
      experimentalCache: true,
      minSize: 0,
      cacheGroups: {
        default: false,
        defaultVendors: false,
        shared: {
          test: (module) => {
            calls.test++;
            return /shared\.js$/.test(module.resource || '');
          },
          name: () => {
            calls.name++;
            return 'shared';
          },
          chunks: (chunk) => {
            calls.chunks++;
            return chunk.name !== 'excluded';
          },
          minChunks: 2,
        },
      },
    },
  },
  plugins: [
    {
      apply(compiler) {
        compiler.hooks.thisCompilation.tap('CacheLog', (compilation) => {
          compilation.hooks.processAssets.tap(
            { name: 'CacheLog', stage: 5000 },
            () => {
              const logging = compilation
                .getStats()
                .toJson({ all: false, logging: 'info' }).logging;
              const entries =
                logging?.['rspack.SplitChunksPlugin']?.entries || [];
              const lines = entries
                .map((entry) => entry.message)
                .filter((message) => message.startsWith('cache:'));
              const delta = Object.fromEntries(
                Object.entries(calls).map(([key, value]) => [
                  key,
                  value - previousCalls[key],
                ]),
              );
              previousCalls = { ...calls };
              compilation.emitAsset(
                'cache-log.json',
                new compiler.rspack.sources.RawSource(
                  JSON.stringify({
                    lines,
                    calls: delta,
                    phases: entries
                      .map((entry) => entry.message)
                      .filter((message) =>
                        message.startsWith('structure cache: phase='),
                      ),
                    verification:
                      process.env.RSPACK_SPLIT_CHUNKS_STRUCTURE_VERIFY === '1',
                  }),
                ),
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
                'cache-map.json',
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
