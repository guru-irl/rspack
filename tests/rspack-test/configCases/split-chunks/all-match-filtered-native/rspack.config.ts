import { defineConfig, definePlugin } from '@rspack/cli';

export default [{ type: 'javascript/auto' }, { layer: 'client' }].map(
  (filter) => {
    const name = filter.type ? 'type' : 'layer';
    return defineConfig({
      name,
      mode: 'development',
      target: 'node',
      entry: { main: { import: './index', layer: 'client' } },
      output: { filename: `${name}-[name].js` },
      optimization: {
        splitChunks: {
          chunks: 'all',
          minSize: 0,
          cacheGroups: {
            default: false,
            defaultVendors: false,
            all: { ...filter, test: /./, name: 'all', enforce: true },
          },
        },
      },
      plugins: [
        definePlugin(function () {
          this.hooks.compilation.tap('CheckAllMatchingGroup', (compilation) => {
            compilation.hooks.afterSeal.tap('CheckAllMatchingGroup', () => {
              const chunk = compilation.namedChunks.get('all');
              expect(chunk).toBeDefined();
              const modules = Array.from(
                compilation.chunkGraph.getChunkModulesIterable(chunk!),
                (module) => module.identifier().replaceAll('\\', '/'),
              );
              expect(modules).toHaveLength(1);
              expect(modules.join('\n')).toContain('/index.js');
            });
          });
        }),
      ],
    });
  },
);
