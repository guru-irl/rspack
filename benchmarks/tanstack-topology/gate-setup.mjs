import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = process.cwd();
const out = path.join(root, '.spider/scratch/tanstack-topology/results');
fs.mkdirSync(out, { recursive: true });
const versions = ['2.2.8', '2.2.9-canary-f2903b64-20261010173351'];
const pluginVersion = '1.171.46';
const patchFile = path.join(root, `benchmarks/tanstack-topology/start-plugin-core-${pluginVersion}-gate-resolver-rebuild.patch`);
let failed = false;
for (const version of versions) {
  const dir = path.join(root, '.spider/scratch/tanstack-topology/apps', version);
  const result = path.join(out, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(result, { recursive: true });
  const rspack = version === '2.2.8' ? version : `npm:@rspack-canary/core@${version}`;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'public-tanstack-resolver-gate', private: true, type: 'module', dependencies: {
    '@rsbuild/core': '2.2.12', '@rsbuild/plugin-react': '2.1.1', '@tanstack/react-start': '1.168.61',
    '@tanstack/react-router': '1.170.42', '@tanstack/start-plugin-core': pluginVersion,
    '@tanstack/start-server-core': '1.169.40', react: '19.3.0', 'react-dom': '19.3.0', '@rspack/core': rspack,
  }, overrides: { '@rspack/core': rspack, '@tanstack/start-plugin-core': pluginVersion, '@tanstack/start-server-core': '1.169.40' } }, null, 2));
  const install = spawnSync('npm', ['install', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 600000 });
  fs.writeFileSync(path.join(result, 'install.log'), install.stdout + install.stderr);
  if (install.status !== 0) { fs.writeFileSync(path.join(result, 'INSTALL_FAILED'), String(install.status)); failed = true; continue; }
  fs.copyFileSync(path.join(dir, 'package-lock.json'), path.join(result, 'package-lock.json'));
  const packageRoot = path.join(dir, 'node_modules/@tanstack/start-plugin-core');
  assert.equal(JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'))).version, pluginVersion);
  const pluginPath = path.join(packageRoot, 'dist/esm/rsbuild/plugin.js');
  const original = fs.readFileSync(pluginPath, 'utf8');
  fs.mkdirSync(path.join(result, 'published'), { recursive: true });
  for (const file of ['plugin.js', 'virtual-modules.js']) fs.copyFileSync(path.join(packageRoot, 'dist/esm/rsbuild', file), path.join(result, 'published', file));
  for (const variant of fs.existsSync(patchFile) ? ['ungated', 'gated'] : ['ungated']) {
    const variantOut = path.join(result, variant);
    fs.mkdirSync(variantOut, { recursive: true });
    fs.writeFileSync(pluginPath, original);
    fs.cpSync(path.join(root, 'benchmarks/tanstack-topology/src'), path.join(dir, 'src'), { recursive: true });
    // Discover additions/removals through the existing imported function module, with no route edit.
    fs.writeFileSync(path.join(dir, 'src/routes/index.tsx'), `import { createFileRoute } from '@tanstack/react-router';
import * as functions from '../functions';
import { Leaf } from '../Leaf';
export const Route = createFileRoute('/')({
  loader: async () => Object.fromEntries(await Promise.all(Object.entries(functions).sort(([a], [b]) => a.localeCompare(b)).map(async ([name, fn]) => [name, await fn()]))),
  component: Home,
});
function Home() {
  const data = Route.useLoaderData();
  return <main><h1>Public resolver gate check</h1><Leaf /><pre>{JSON.stringify(data)}</pre></main>;
}
`);
    if (variant === 'gated') {
      const apply = spawnSync('patch', ['--batch', '-p1', '-i', patchFile], { cwd: packageRoot, encoding: 'utf8' });
      fs.writeFileSync(path.join(variantOut, 'patch-apply.log'), apply.stdout + apply.stderr);
      assert.equal(apply.status, 0, 'published dist patch applies');
      fs.copyFileSync(pluginPath, path.join(variantOut, 'patched-plugin.js'));
    }
    // Test-only observation, shared by both variants. Do not change update/rebuild decisions.
    let instrumented = fs.readFileSync(pluginPath, 'utf8');
    const nonRsc = 'virtualModuleState.updateServerFnResolver();\n';
    const hookStart = instrumented.indexOf('name: "TanStackStartServerFnResolverRebuild"');
    const update = instrumented.indexOf(nonRsc, hookStart);
    assert.ok(update > hookStart);
    instrumented = instrumented.slice(0, update) + `globalThis.__publicResolverProbe ??= [];\n\t\t\t\t\t\tglobalThis.__publicResolverProbe.push({ name: utils.environment.name, content: virtualModuleState.generateCurrentResolverContent(utils.environment.name === serverFnProviderEnv) });\n\t\t\t\t\t\t` + instrumented.slice(update);
    fs.writeFileSync(pluginPath, instrumented);
    fs.copyFileSync(pluginPath, path.join(variantOut, 'observed-plugin.js'));
    fs.copyFileSync(path.join(root, 'benchmarks/tanstack-topology/gate-run.mjs'), path.join(dir, 'gate-run.mjs'));
    const run = spawnSync('/usr/bin/time', ['-v', '-o', path.join(variantOut, 'process-time.txt'), 'node', 'gate-run.mjs'], { cwd: dir, env: { ...process.env, NODE_ENV: 'development', RESULT_DIR: variantOut, VARIANT: variant }, encoding: 'utf8', timeout: 480000 });
    fs.writeFileSync(path.join(variantOut, 'console.log'), run.stdout + run.stderr);
    fs.writeFileSync(path.join(variantOut, 'exit.json'), JSON.stringify({ status: run.status, signal: run.signal, error: run.error?.message }));
    console.log(version, variant, run.status, (run.stdout + run.stderr).slice(-4000));
    if (run.status !== 0) failed = true;
  }
  if (fs.existsSync(patchFile) && !failed) {
    const before = JSON.parse(fs.readFileSync(path.join(result, 'ungated/checks.json')));
    const after = JSON.parse(fs.readFileSync(path.join(result, 'gated/checks.json')));
    const visible = (checks) => checks.map(({ step, ssr, calls, removed }) => ({ step, ssr, calls, removed }));
    assert.deepEqual(visible(after), visible(before), 'gated and ungated SSR/RPC/error parity');
    fs.writeFileSync(path.join(result, 'parity.json'), JSON.stringify({ passed: true, steps: before.length }, null, 2));
  }
}
if (failed) process.exitCode = 1;
