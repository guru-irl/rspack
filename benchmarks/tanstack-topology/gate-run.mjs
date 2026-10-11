import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/rsbuild';

const out = process.env.RESULT_DIR;
fs.mkdirSync(out, { recursive: true });
const builds = [];
const checks = [];
let step = 'initial';
let waiter;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const isResolver = (id) => id.includes('_tanstack-start-server-fn-resolver.js');
const probe = {
  name: 'public-resolver-gate-probe',
  setup(api) {
    api.modifyRspackConfig((config, { environment }) => {
      config.stats = { all: false, errors: true, timings: true, logging: 'verbose', loggingDebug: [/rspack\./] };
      config.plugins.push({ apply(compiler) {
        let current;
        compiler.hooks.thisCompilation.tap('PublicResolverGateProbe', (compilation) => {
          current = { step, name: environment.name, explicit: [], built: [] };
          const rebuild = compilation.rebuildModule.bind(compilation);
          compilation.rebuildModule = (module, callback) => {
            current.explicit.push(module.identifier());
            return rebuild(module, callback);
          };
          compilation.hooks.buildModule.tap('PublicResolverGateProbe', (module) => {
            current.built.push(module.identifier());
          });
          compilation.hooks.finishModules.tap({ name: 'PublicResolverGateProbe', stage: 10000 }, (modules) => {
            current.resolvers = [...modules].filter((m) => isResolver(m.identifier())).map((m) => {
              const content = String(m.originalSource()?.source() ?? '');
              return { id: m.identifier(), content, hash: sha(content) };
            });
          });
        });
        compiler.hooks.done.tap('PublicResolverGateProbe', (stats) => {
          const data = stats.toJson({ all: false, errors: true, logging: 'verbose', loggingDebug: [/rspack\./] });
          const logging = data.logging ?? {};
          const messages = Object.values(logging).flatMap((l) => l.entries ?? []);
          const graph = Object.entries(logging).filter(([name]) => name === 'rspack.Compilation').flatMap(([, l]) => l.entries ?? []).find((e) => e.type === 'time' && e.message?.startsWith('build chunk graph:'));
          const generated = (globalThis.__publicResolverProbe ?? []).filter((r) => r.name === environment.name).at(-1)?.content;
          const record = { ...current, ms: stats.endTime - stats.startTime, graphMessage: graph?.message,
            topology: messages.filter((e) => e.message?.includes('module topology change detected')).map((e) => e.message),
            errors: data.errors, generated, generatedHash: generated === undefined ? null : sha(generated), memory: process.memoryUsage() };
          builds.push(record);
          fs.writeFileSync(path.join(out, 'builds.json'), JSON.stringify(builds, null, 2));
          if (environment.name === 'ssr') {
            waiter?.resolve(record);
            waiter = undefined;
          }
        });
      } });
    });
  },
};
const waitBuild = () => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { waiter = undefined; reject(new Error(`SSR timeout: ${step}`)); }, 90000);
  waiter = { resolve: (r) => { clearTimeout(timer); resolve(r); } };
});
const rsbuild = await createRsbuild({ config: {
  plugins: [pluginReact(), tanstackStart(), probe],
  performance: { buildCache: false },
  server: { port: 3100, strictPort: true, open: false },
} });
const functionsFile = path.resolve('src/functions.ts');
const leafFile = path.resolve('src/Leaf.tsx');
const originalFunctions = fs.readFileSync(functionsFile, 'utf8');
const originalLeaf = fs.readFileSync(leafFile, 'utf8');
let server;
let previousHash;
let knownIds = {};
const rpc = async (id) => {
  const response = await fetch(`http://localhost:3100/_serverFn/${encodeURIComponent(id)}`, { headers: { 'x-tsr-serverFn': 'true', origin: 'http://localhost:3100', 'sec-fetch-site': 'same-origin' } });
  const text = await response.text();
  // Compare the meaningful error, not stack paths, trace IDs, or serialization refs.
  const error = /Server function (?:info not found for|module export not resolved for serverFn ID:)[^"\\]*/.exec(text)?.[0];
  return { status: response.status, text, error };
};
const sample = async (name, expected, leafText, removedName) => {
  let response;
  let html;
  let data;
  for (let i = 0; i < 100; i++) {
    response = await fetch('http://localhost:3100/');
    html = await response.text();
    const pre = /<pre>([\s\S]*?)<\/pre>/.exec(html)?.[1];
    try { data = JSON.parse(pre?.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')); } catch {}
    if (response.status === 200 && JSON.stringify(data) === JSON.stringify(expected) && html.includes(leafText)) break;
    await pause(100);
  }
  assert.equal(response.status, 200, `${name}: SSR status`);
  assert.deepEqual(data, expected, `${name}: SSR values`);
  assert.ok(html.includes(leafText), `${name}: leaf value`);
  const ssr = builds.filter((b) => b.name === 'ssr' && b.step === name);
  assert.ok(ssr.length, `${name}: SSR compilation observed`);
  assert.ok(ssr.every((b) => !b.errors?.length), `${name}: compilation errors`);
  const last = ssr.at(-1);
  assert.ok(last.generated, `${name}: generated resolver captured`);
  assert.equal(last.resolvers.length, 1, `${name}: compiled resolver observed`);
  assert.equal(last.resolvers[0].hash, last.generatedHash, `${name}: compiled resolver matches generated bytes`);
  const ids = {};
  for (const match of last.generated.matchAll(/'([^']+)': \{\s*functionName: '([^']+)'/g)) ids[match[2].replace('_createServerFn_handler', '')] = match[1];
  const calls = {};
  for (const [fn, value] of Object.entries(expected)) {
    assert.ok(ids[fn], `${name}: ${fn} resolver entry`);
    const result = await rpc(ids[fn]);
    assert.equal(result.status, 200, `${name}: ${fn} RPC status: ${result.text}`);
    assert.ok(result.text.includes(value), `${name}: ${fn} RPC value: ${result.text}`);
    calls[fn] = { status: result.status, value, response: result.text };
  }
  let removed;
  if (removedName) {
    assert.ok(knownIds[removedName], `${name}: old ID recorded`);
    removed = await rpc(knownIds[removedName]);
    assert.ok(removed.status >= 400, `${name}: removed function must fail: ${removed.text}`);
    assert.deepEqual(JSON.parse(removed.text), { status: 500, unhandled: true, message: 'HTTPError' }, `${name}: removed function error`);
    assert.equal(ids[removedName], undefined, `${name}: removed manifest entry`);
    removed = { status: removed.status, response: removed.text };
  }
  const changed = previousHash === undefined || previousHash !== last.generatedHash;
  const explicit = ssr.flatMap((b) => b.explicit).filter(isResolver).length;
  const topology = ssr.flatMap((b) => b.topology).length;
  const gatePass = name === 'initial' ? explicit > 0 : name.startsWith('leaf-') ? explicit === 0 && topology === 0 : !changed || explicit > 0;
  if (process.env.VARIANT === 'gated') assert.ok(gatePass, `${name}: gate behavior (changed=${changed}, explicit=${explicit}, topology=${topology})`);
  if (name.startsWith('leaf-')) assert.equal(changed, false, `${name}: unchanged generated bytes`);
  if (['add', 'remove', 'rename'].includes(name)) assert.equal(changed, true, `${name}: resolver bytes change`);
  if (name === 'body') assert.ok(ssr.some((b) => b.built.some((id) => id.includes('functions.ts'))), 'handler body: normal handler module rebuild');
  const check = { step: name, ssr: { status: response.status, data, leaf: leafText }, calls, removed,
    generatedHash: last.generatedHash, bytesChanged: changed, explicitResolverRebuilds: explicit, topologyLogs: topology, gatePass,
    normalFunctionModuleBuilds: ssr.flatMap((b) => b.built).filter((id) => id.includes('functions.ts')).length };
  checks.push(check);
  knownIds = { ...knownIds, ...ids };
  previousHash = last.generatedHash;
  fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
  console.log('CHECK', JSON.stringify(check));
};
const edit = async (name, file, text, expected, removed) => {
  await pause(600);
  step = name;
  const next = waitBuild();
  fs.writeFileSync(file, text);
  await next;
  await sample(name, expected, name.startsWith('leaf-') && Number(name.slice(5)) % 2 ? 'Public leaf changed' : 'Public leaf baseline', removed);
};
try {
  const initial = waitBuild();
  server = await rsbuild.startDevServer();
  await initial;
  const base = { alpha: 'alpha-public', beta: 'beta-public', gamma: 'gamma-public' };
  await sample('initial', base, 'Public leaf baseline');
  for (let i = 1; i <= 8; i++) await edit(`leaf-${i}`, leafFile, i % 2 ? originalLeaf.replace('Public leaf baseline', 'Public leaf changed') : originalLeaf, base);
  const added = originalFunctions + "\nexport const delta = createServerFn({ method: 'GET' }).handler(async () => 'delta-public');\n";
  await edit('add', functionsFile, added, { alpha: 'alpha-public', beta: 'beta-public', delta: 'delta-public', gamma: 'gamma-public' });
  await edit('remove', functionsFile, originalFunctions, base, 'delta');
  const body = originalFunctions.replace('alpha-public', 'alpha-body-public');
  await edit('body', functionsFile, body, { ...base, alpha: 'alpha-body-public' });
  const renamed = body.replaceAll('gamma', 'epsilon');
  await edit('rename', functionsFile, renamed, { alpha: 'alpha-body-public', beta: 'beta-public', epsilon: 'epsilon-public' }, 'gamma');
  const failedGate = checks.filter((c) => !c.gatePass);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ variant: process.env.VARIANT, checks: checks.length, failedGateSteps: failedGate.map((c) => c.step), passed: true }, null, 2));
} finally {
  if (server?.close) await server.close();
  else if (server?.server?.close) await server.server.close();
}
process.exit(0);
