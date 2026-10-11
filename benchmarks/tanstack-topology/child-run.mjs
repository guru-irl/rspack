import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/rsbuild';
import { rspack } from '@rspack/core';
const out = process.env.RESULT_DIR;
const evidence = { variant: process.env.VARIANT, events: [], parentExplicit: [], childExplicit: [], checks: [] };
const save = () => fs.writeFileSync(path.join(out, 'child-check.json'), JSON.stringify(evidence, null, 2));
const isResolver = (m) => m.identifier().includes('_tanstack-start-server-fn-resolver.js');
const probe = { name: 'public-child-resolver-check', setup(api) {
  api.modifyRspackConfig((config, { environment }) => {
    if (environment.name !== 'ssr') return;
    // SSR-only discovery cannot be pre-populated by the preceding client build.
    config.entry.late = { import: [path.resolve('src/late-functions.ts')] };
    config.module.rules.push({ test: /late-functions\.ts$/, enforce: 'pre', use: [path.resolve('late-loader.cjs')] });
    config.plugins.push({ apply(compiler) {
      const observe = (compilation, child) => {
        const rebuild = compilation.rebuildModule.bind(compilation);
        compilation.rebuildModule = (module, callback) => {
          if (isResolver(module)) (child ? evidence.childExplicit : evidence.parentExplicit).push(module.identifier());
          return rebuild(module, callback);
        };
      };
      compiler.hooks.thisCompilation.tap('PublicChildResolverCheck', (compilation) => {
        observe(compilation, false);
        globalThis.__publicResolverBuilt = new Promise((resolve) => {
          compilation.hooks.succeedModule.tap('PublicResolverBeforeLateDiscovery', (module) => {
            if (isResolver(module)) resolve();
          });
        });
        compilation.hooks.finishModules.tap('PublicChildResolverCheck', (modules) => {
          evidence.parentResolvers = [...modules].filter(isResolver).map((m) => String(m.originalSource()?.source() ?? ''));
        });
      });
      compiler.hooks.finishMake.tapPromise({ name: 'PublicChildResolverCheck', stage: -15 }, async (compilation) => {
        if (compilation.compiler !== compiler) return;
        evidence.events.push('parent-stage-minus-15');
        const child = compilation.createChildCompiler('public-resolver-child', { filename: 'child-resolver.js' }, [
          new rspack.EntryPlugin(compiler.context, path.resolve('src/child-entry.js'), { name: 'child-resolver' }),
        ]);
        // Preserve the real parent metadata snapshot in the child. Otherwise the
        // unrelated copied metadata tap drops SSR-only discoveries for this empty child.
        child.hooks.finishMake.tap({ name: 'PublicChildMetadataSnapshot', stage: -21 }, (childCompilation) => {
          const metadata = Object.assign({}, ...[...compilation.modules].map((m) => m.buildInfo['tanstack.start.serverFns']?.serverFnsById ?? {}));
          [...childCompilation.modules][0].buildInfo['tanstack.start.serverFns'] = { version: 1, serverFnsById: metadata };
        });
        child.hooks.thisCompilation.tap('PublicChildResolverObservation', (childCompilation) => observe(childCompilation, true));
        child.hooks.finishMake.tap({ name: 'PublicChildAfterGate', stage: 0 }, () => evidence.events.push('child-after-gate'));
        await new Promise((resolve, reject) => child.runAsChild((error, entries, childCompilation) => {
          if (error) return reject(error);
          if (childCompilation.errors.length) return reject(new Error(childCompilation.errors.map(String).join('\n')));
          resolve();
        }));
        evidence.events.push('child-completed');
      });
      compiler.hooks.finishMake.tap({ name: 'PublicParentAfterGate', stage: 0 }, (compilation) => {
        if (compilation.compiler === compiler) evidence.events.push('parent-after-gate');
      });
    } });
  });
} };
try {
  const rsbuild = await createRsbuild({ config: {
    plugins: [pluginReact(), tanstackStart(), probe], performance: { buildCache: false },
  } });
  await rsbuild.build();
  const generated = (globalThis.__publicResolverProbe ?? []).filter((p) => p.name === 'ssr').at(-1)?.content;
  evidence.generated = generated;
  const compiled = evidence.parentResolvers?.[0];
  evidence.compiledMatchesGenerated = compiled === generated;
  const ids = {};
  for (const match of (generated ?? '').matchAll(/'([^']+)': \{\s*functionName: '([^']+)'/g)) ids[match[2].replace('_createServerFn_handler', '')] = match[1];
  evidence.ids = ids;
  // Execute the emitted production bundle, not a dev server or a second compilation.
  const entry = await import(pathToFileURL(path.resolve('dist/server/index.js')).href);
  const handler = typeof entry.default === 'function' ? entry.default : entry.default.fetch.bind(entry.default);
  for (const [name, value] of Object.entries({ alpha: 'alpha-public', beta: 'beta-public', gamma: 'gamma-public', late: 'late-public' })) {
    const response = await handler(new Request(`http://localhost/_serverFn/${encodeURIComponent(ids[name])}`, {
      headers: { 'x-tsr-serverFn': 'true', origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
    }));
    const text = await response.text();
    evidence.checks.push({ name, status: response.status, text, expected: value });
  }
  const response = await handler(new Request('http://localhost/'));
  const html = await response.text();
  evidence.ssr = { status: response.status, valuesPresent: ['alpha-public', 'beta-public', 'gamma-public'].every((v) => html.includes(v)) };
  save();
  assert.deepEqual(evidence.events, ['parent-stage-minus-15', 'child-after-gate', 'child-completed', 'parent-after-gate']);
  assert.equal((globalThis.__publicResolverProbe ?? []).filter((p) => p.name === 'ssr').length, 2, 'copied child gate and parent gate both ran');
  assert.equal(evidence.parentResolvers.length, 1, 'parent resolver observed');
  assert.equal(compiled, generated, 'parent compiled resolver includes every discovered function');
  assert.deepEqual(Object.keys(ids).sort(), ['alpha', 'beta', 'gamma', 'late']);
  for (const check of evidence.checks) {
    assert.equal(check.status, 200, `${check.name}: emitted resolver RPC status: ${check.text}`);
    assert.ok(check.text.includes(check.expected), `${check.name}: emitted resolver RPC value`);
  }
  assert.equal(evidence.ssr.status, 200, 'emitted SSR status');
  assert.ok(evidence.ssr.valuesPresent, 'emitted SSR values');
  assert.ok(evidence.parentExplicit.length > 0, 'parent first build must rebuild resolver after discovery');
  evidence.passed = true;
  save();
  console.log('CHILD_PASS', JSON.stringify(evidence));
} catch (error) {
  evidence.passed = false;
  evidence.error = error.stack;
  save();
  console.error(error);
  process.exitCode = 1;
}
