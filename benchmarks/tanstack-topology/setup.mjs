import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const out = path.join(root, '.spider/scratch/tanstack-topology/results');
fs.mkdirSync(out, { recursive: true });
const metadata = await (
  await fetch('https://registry.npmjs.org/@rspack%2fcore')
).json();
fs.writeFileSync(
  path.join(out, 'rspack-tags.json'),
  JSON.stringify(metadata['dist-tags'], null, 2),
);
const versions = ['2.2.8'];
const canaryResponse = await fetch('https://registry.npmjs.org/@rspack-canary%2fcore');
const canaryMetadata = canaryResponse.ok ? await canaryResponse.json() : null;
fs.writeFileSync(path.join(out, 'main-canary.json'), JSON.stringify(canaryMetadata ? { tags: canaryMetadata['dist-tags'], published: canaryMetadata.time[canaryMetadata['dist-tags'].latest] } : { unavailable: canaryResponse.status }, null, 2));
const canary = canaryMetadata?.['dist-tags'].latest;
if (canary) versions.push(canary);
if (process.env.DIAGNOSTIC_ONLY) versions.shift();
fs.writeFileSync(
  path.join(out, 'selected-versions.json'),
  JSON.stringify(versions),
);
for (const version of versions) {
  const dir = path.join(
    root,
    '.spider/scratch/tanstack-topology/apps',
    version,
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(
    path.join(root, 'benchmarks/tanstack-topology/src'),
    path.join(dir, 'src'),
    { recursive: true },
  );
  const pkg = {
    name: 'public-tanstack-topology',
    private: true,
    type: 'module',
    dependencies: {
      '@rsbuild/core': '2.2.12',
      '@rsbuild/plugin-react': '2.1.1',
      '@tanstack/react-start': '1.168.61',
      '@tanstack/react-router': 'latest',
      react: 'latest',
      'react-dom': 'latest',
      '@rspack/core': version === '2.2.8' ? version : `npm:@rspack-canary/core@${version}`,
    },
    overrides: { '@rspack/core': version === '2.2.8' ? version : `npm:@rspack-canary/core@${version}` },
  };
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(pkg, null, 2),
  );
  const result = path.join(out, version);
  fs.mkdirSync(result, { recursive: true });
  const install = spawnSync(
    'npm',
    [
      'install',
      '--registry=https://registry.npmjs.org',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: dir, encoding: 'utf8', timeout: 600000 },
  );
  fs.writeFileSync(
    path.join(result, 'install.log'),
    install.stdout + install.stderr,
  );
  if (install.status !== 0) {
    fs.writeFileSync(
      path.join(result, 'INSTALL_FAILED'),
      String(install.status),
    );
    continue;
  }
  fs.copyFileSync(
    path.join(dir, 'package-lock.json'),
    path.join(result, 'package-lock.json'),
  );
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|map|json)$/.test(p) && /start-plugin-core/.test(p)) {
        const relative = path.relative(path.join(dir, 'node_modules'), p);
        if (!p.endsWith('.map')) {
          const to = path.join(result, 'published', relative);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(p, to);
        }
      }
    }
  };
  walk(path.join(dir, 'node_modules/@tanstack/start-plugin-core'));
  if (!process.env.DIAGNOSTIC_ONLY) {
    fs.copyFileSync(path.join(root, 'benchmarks/tanstack-topology/watch-probe.mjs'), path.join(dir, 'watch-probe.mjs'));
    const probeOut = path.join(result, 'watch-probe');
    fs.mkdirSync(probeOut, { recursive: true });
    const probe = spawnSync('node', ['watch-probe.mjs'], { cwd: dir, env: { ...process.env, RESULT_DIR: probeOut }, encoding: 'utf8', timeout: 180000 });
    fs.writeFileSync(path.join(probeOut, 'console.log'), probe.stdout + probe.stderr);
    fs.writeFileSync(path.join(probeOut, 'exit.json'), JSON.stringify({ status: probe.status, signal: probe.signal }));
    console.log(version, 'watch-probe', probe.status, (probe.stdout + probe.stderr).slice(-2000));
  }
  const pluginPath = path.join(dir, 'node_modules/@tanstack/start-plugin-core/dist/esm/rsbuild/plugin.js');
  const wrapperPath = path.join(dir, 'node_modules/@tanstack/start-server-core/dist/esm/getServerFnById.js');
  const originalPlugin = fs.readFileSync(pluginPath, 'utf8');
  const originalWrapper = fs.readFileSync(wrapperPath, 'utf8');
  for (const variant of (process.env.DIAGNOSTIC_ONLY ? ['baseline'] : ['baseline', 'content-gated-resolver', 'retain-wrapper'])) {
    fs.writeFileSync(pluginPath, originalPlugin);
    fs.writeFileSync(wrapperPath, originalWrapper);
    fs.cpSync(path.join(root, 'benchmarks/tanstack-topology/src'), path.join(dir, 'src'), { recursive: true });
    if (variant === 'content-gated-resolver') {
      const before = 'virtualModuleState.updateServerFnResolver();\n\t\t\t\t\t\tawait rebuildModulesContaining(compilation, virtualModuleState.serverFnResolverPath);';
      const after = `const nextContent = virtualModuleState.generateCurrentResolverContent(false);
                        const changed = compilation.compiler.__publicResolverContent !== nextContent;
                        virtualModuleState.updateServerFnResolver();
                        if (changed) await rebuildModulesContaining(compilation, virtualModuleState.serverFnResolverPath);
                        compilation.compiler.__publicResolverContent = nextContent;`;
      if (!originalPlugin.includes(before)) throw new Error('Published plugin patch anchor missing');
      fs.writeFileSync(pluginPath, originalPlugin.replace(before, after));
    }
    if (variant === 'retain-wrapper') fs.writeFileSync(wrapperPath, `globalThis.__PUBLIC_TOPOLOGY_WRAPPER_RETAIN__ = true;\n${originalWrapper}`);
    fs.mkdirSync(path.join(result, variant), { recursive: true });
    fs.writeFileSync(path.join(result, variant, 'tanstack-plugin.js'), fs.readFileSync(pluginPath));
    fs.writeFileSync(path.join(result, variant, 'getServerFnById.js'), fs.readFileSync(wrapperPath));
    fs.cpSync(
      path.join(root, 'benchmarks/tanstack-topology/run.mjs'),
      path.join(dir, 'run.mjs'),
    );
    const run = spawnSync('/usr/bin/time', ['-v', '-o', path.join(result, variant, 'process-time.txt'), 'node', 'run.mjs'], {
      cwd: dir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        RESULT_DIR: path.join(result, variant),
        VARIANT: variant,
      },
      encoding: 'utf8',
      timeout: 480000,
    });
    fs.mkdirSync(path.join(result, variant), { recursive: true });
    fs.writeFileSync(
      path.join(result, variant, 'console.log'),
      run.stdout + run.stderr,
    );
    fs.writeFileSync(
      path.join(result, variant, 'exit.json'),
      JSON.stringify({
        status: run.status,
        signal: run.signal,
        error: run.error?.message,
      }),
    );
    console.log(
      version,
      variant,
      run.status,
      (run.stdout + run.stderr).slice(-6000),
    );
  }
}
