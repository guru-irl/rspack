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
const canaries = Object.keys(metadata.versions)
  .filter((v) => v.includes('canary'))
  .sort((a, b) => Date.parse(metadata.time[b]) - Date.parse(metadata.time[a]));
if (canaries.length) versions.push(canaries[0]);
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
      '@rsbuild/core': 'latest',
      '@rsbuild/plugin-react': 'latest',
      '@tanstack/react-start': 'latest',
      '@tanstack/react-router': 'latest',
      react: 'latest',
      'react-dom': 'latest',
      '@rspack/core': version,
    },
    overrides: { '@rspack/core': version },
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
  for (const variant of ['baseline', 'skip-identical-resolver-rebuild']) {
    fs.cpSync(
      path.join(root, 'benchmarks/tanstack-topology/run.mjs'),
      path.join(dir, 'run.mjs'),
    );
    const run = spawnSync('node', ['run.mjs'], {
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
