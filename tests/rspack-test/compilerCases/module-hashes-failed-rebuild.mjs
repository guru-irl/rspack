import fs from 'node:fs';
import path from 'node:path';
import { rspack } from '@rspack/core';

function run(compiler, modifiedFiles) {
  return new Promise((resolve, reject) => {
    compiler.run(
      (error, stats) => {
        if (error) return reject(error);
        expect(stats.hasErrors()).toBe(false);
        resolve(stats);
      },
      modifiedFiles && {
        modifiedFiles: new Set(modifiedFiles),
        removedFiles: new Set(),
      },
    );
  });
}

function snapshot(stats) {
  const { compilation } = stats;
  return {
    chunks: [...compilation.chunks]
      .map((chunk) => [
        chunk.id,
        compilation.chunkGraph
          .getChunkModules(chunk)
          .map((module) => module.identifier())
          .sort(),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    assets: Object.fromEntries(
      compilation
        .getAssets()
        .map(({ name, source }) => [
          name,
          Buffer.from(source.source()).toString('hex'),
        ]),
    ),
  };
}

/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
  description:
    'should recover all module hashes after a failed rebuild adds modules',
  options(context) {
    const root = context.getDist('src');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'index.js'),
      "import('./asset.js'); import('./other.js');",
    );
    fs.writeFileSync(
      path.join(root, 'asset.js'),
      "import url from './img.png'; export default url;",
    );
    fs.writeFileSync(path.join(root, 'other.js'), 'export default 1;');
    fs.writeFileSync(path.join(root, 'img.png'), 'PNG-0');
    // Many new modules make the failure independent of hash-set iteration order.
    for (let i = 0; i < 512; i++) {
      fs.writeFileSync(path.join(root, `new${i}.js`), `export default ${i};`);
    }
    let fail = false;
    let builds = 0;
    return {
      context: fs.realpathSync(root),
      mode: 'development',
      devtool: false,
      entry: { main: './index.js' },
      cache: true,
      incremental: true,
      output: {
        path: context.getDist('output'),
        filename: '[name].[contenthash:8].js',
        chunkFilename: '[id].[contenthash:8].js',
        assetModuleFilename() {
          if (fail) throw new Error('asset filename failure');
          return '[hash][ext]';
        },
      },
      module: { rules: [{ test: /\.png$/, type: 'asset/resource' }] },
      optimization: {
        chunkIds: 'deterministic',
        moduleIds: 'named',
        minimize: false,
        splitChunks: { chunks: 'all', minSize: 0 },
      },
      plugins: [
        (compiler) => {
          compiler.hooks.beforeRun.tap('FailAssetFilename', () => {
            fail = ++builds === 2;
          });
        },
      ],
    };
  },
  async build(context, compiler) {
    const root = compiler.options.context;
    const write = (file, source) =>
      fs.writeFileSync(path.join(root, file), source);
    await run(compiler);
    write(
      'index.js',
      "import('./asset.js'); import('./other.js');\n" +
        Array.from({ length: 512 }, (_, i) => `import('./new${i}.js');`).join(
          '\n',
        ),
    );
    write('img.png', 'PNG-fail');
    await expect(
      run(compiler, [path.join(root, 'index.js'), path.join(root, 'img.png')]),
    ).rejects.toThrow('Failed to render filename function');
    // Only an unrelated module is marked modified after the hashing failure.
    write('other.js', 'export default 2;');
    const recovered = snapshot(
      await run(compiler, [path.join(root, 'other.js')]),
    );
    const cold = rspack({
      ...compiler.options,
      cache: false,
      incremental: false,
      plugins: [],
    });
    cold.outputFileSystem = compiler.outputFileSystem;
    try {
      expect(recovered).toEqual(snapshot(await run(cold)));
    } finally {
      await new Promise((resolve, reject) =>
        cold.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
};
