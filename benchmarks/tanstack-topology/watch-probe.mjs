import fs from 'node:fs';
import path from 'node:path';
import { rspack } from '@rspack/core';

const dir = path.resolve('watch-probe-fixture');
const out = process.env.RESULT_DIR;
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const fixture = {
  'package.json': JSON.stringify({ type: 'module', sideEffects: false }),
  'index.js': `import { lookup } from './wrapper.js'; import { text } from './leaf.js'; export { lookup, text };`,
  'wrapper.js': `export { lookup } from './resolver.js';`,
  'resolver.js': `export const lookup = () => import('./handler.js').then(m => m.value);`,
  'handler.js': `export const value = 'public-handler';`,
  'leaf.js': `export const text = 'baseline';`,
};
for (const [name, text] of Object.entries(fixture)) fs.writeFileSync(path.join(dir, name), text);
let waiting;
let index = 0;
const records = [];
const compiler = rspack({
  context: dir,
  mode: 'development',
  target: 'node',
  entry: './index.js',
  output: { path: path.join(dir, 'dist'), filename: 'main.cjs', library: { type: 'commonjs2' } },
  optimization: { sideEffects: true, usedExports: true, concatenateModules: false, minimize: false },
  plugins: [{ apply(compiler) {
    compiler.hooks.finishMake.tapPromise('RebuildStableResolver', async compilation => {
      const m = [...compilation.modules].find(m => m.resource === path.join(dir, 'resolver.js'));
      if (m) await new Promise((resolve, reject) => compilation.rebuildModule(m, error => error ? reject(error) : resolve()));
    });
    compiler.hooks.done.tap('PublicWatchProbe', stats => {
      const data = stats.toJson({ all: false, errors: true, logging: 'verbose', loggingDebug: [/rspack\./] });
      const wrapper = [...stats.compilation.modules].find(m => m.resource === path.join(dir, 'wrapper.js'));
      const record = {
        index: index++, errors: data.errors, logging: data.logging,
        wrapperChunks: wrapper ? [...stats.compilation.chunkGraph.getModuleChunksIterable(wrapper)].map(c => c.name ?? c.id) : null,
      };
      records.push(record);
      waiting?.resolve(record);
      waiting = undefined;
    });
  } }],
});
const wait = () => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('watch probe timeout')), 60000);
  waiting = { resolve: r => { clearTimeout(timer); resolve(r); } };
});
const initial = wait();
const watching = compiler.watch({}, error => { if (error) throw error; });
try {
  await initial;
  for (let i = 1; i <= 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 600));
    const next = wait();
    fs.writeFileSync(path.join(dir, 'leaf.js'), `export const text = '${i === 1 ? 'changed' : 'baseline'}';`);
    await next;
  }
  const misses = records.slice(1).flatMap(r => Object.values(r.logging ?? {}).flatMap(v => v.entries.filter(e => /module topology change detected/.test(e.message)).map(e => e.message)));
  fs.writeFileSync(path.join(out, 'watch-probe.json'), JSON.stringify({ records, misses, reuseAssertionPasses: misses.length === 0 }, null, 2));
  fs.cpSync(dir, path.join(out, 'fixture'), { recursive: true, filter: src => !src.includes('/dist') });
  if (records.some(r => r.errors?.length)) throw new Error('Watch probe compilation failed');
  console.log('PUBLIC WATCH PROBE', JSON.stringify({ rebuilds: records.length - 1, misses: misses.map(m => m.split('!').at(-1)), wrapperChunks: records.map(r => r.wrapperChunks), reuseAssertionPasses: misses.length === 0 }));
} finally {
  await new Promise((resolve, reject) => watching.close(error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
}
