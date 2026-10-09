import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const clean = id => id.split(root).join('<app>');
const { build } = await import('vite');
const { tanstackRouter } = await import('@tanstack/router-plugin/vite');
const plugins = [tanstackRouter({ target: 'react', autoCodeSplitting: true, routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' })].flat(Infinity);
const reference = plugins.find(p => p.name === 'tanstack-router:code-splitter:compile-reference-file');
if (!reference?.transform?.handler) throw new Error('Missing reference object hook');
const codeFilter = reference.transform.filter.code;
const filters = {
  S: globalThis.__viteTransformFilterFactory({ exclude: ['tsr-split', 'tsr-shared'], include: /\.(m|c)?(j|t)sx?$/ }, codeFilter),
  R: globalThis.__viteTransformFilterFactory({ exclude: [/[?&]tsr-split(?:[=&]|$)/, /[?&]tsr-shared(?:[=&]|$)/], include: /\.(m|c)?(j|t)sx?$/ }, codeFilter),
  N: globalThis.__viteTransformFilterFactory({ include: /\.(m|c)?(j|t)sx?$/ }, codeFilter),
};
const ids = [];
const handlers = [];
const handler = reference.transform.handler;
reference.transform.handler = function(code, id, ...rest) { handlers.push(clean(id)); return handler.call(this, code, id, ...rest); };
const inspector = { name: 'benchmark-id-observer', enforce: 'pre', transform(code, id) {
  ids.push({ id: clean(id), stockExcludeMatch: ['tsr-split', 'tsr-shared'].some(p => globalThis.__viteIdFilterFactory(p)(id)),
    ...Object.fromEntries(Object.entries(filters).map(([arm, f]) => [arm, f(id, code)])) });
} };
await build({ root, logLevel: 'warn', plugins: [inspector, ...plugins], build: { outDir: 'vite-dist', minify: false, sourcemap: false } });
fs.writeFileSync(process.env.BENCH_RESULT, JSON.stringify({ ids, handlers }, null, 2));
