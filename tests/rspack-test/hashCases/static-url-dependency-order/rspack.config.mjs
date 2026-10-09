import path from 'node:path';

function config(delayed) {
  return {
    mode: 'development',
    context: import.meta.dirname,
    cache: false,
    incremental: false,
    devtool: false,
    entry: { left: './left.js', right: './right.js' },
    output: {
      path: path.resolve(import.meta.dirname, `dist/${delayed}`),
      filename: '[name].js',
      publicPath: '',
    },
    module: {
      parser: { javascript: { url: 'new-url-relative' } },
      rules: [
        {
          test: /\.js$/,
          use: [{
            loader: path.resolve(import.meta.dirname, 'delay.cjs'),
            ident: 'delay',
            options: { delayed },
          }],
        },
        { test: /\.svg$/, type: 'asset/resource' },
      ],
    },
  };
}

export default [config('left.js'), config('right.js')];
