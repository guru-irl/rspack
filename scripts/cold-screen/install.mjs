import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const phase = process.argv[2];
if (!['S0', 'S1'].includes(phase)) throw new Error('Expected S0 or S1');
const results = path.resolve('bench-data/results');
fs.mkdirSync(results, {recursive: true});
const environment = {started: new Date().toISOString(), phase, platform: process.platform, arch: process.arch, node: process.version, os: os.version(), release: os.release(), cpus: os.cpus(), ram: os.totalmem(), image: process.env.ImageOS, imageVersion: process.env.ImageVersion, commit: process.env.GITHUB_SHA};
if (!['linux', 'darwin'].includes(process.platform) || process.arch !== (process.platform === 'linux' ? 'x64' : 'arm64')) throw new Error('Wrong hosted runner platform');
fs.writeFileSync(path.join(results, 'environment.json'), JSON.stringify(environment, null, 2));
const manifest = {};
const specs = [['OFFICIAL-229', '@rspack/core', '2.2.9']];
if (phase === 'S0') specs.push(['CANARY-96dcd72d', '@rspack-canary/core', '2.2.10-canary-96dcd72d-20261016173339']);
function npm(args, label) {
  const child = spawnSync('npm', [...args, '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'], {encoding: 'utf8', timeout: 240000});
  fs.writeFileSync(path.join(results, `${label}.log`), `${child.stdout || ''}\n${child.stderr || ''}`);
  if (child.error || child.status !== 0) throw new Error(`Published install failed (${label}): ${child.stderr}`);
}
function packageAt(entry) {
  let dir = path.dirname(entry);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot locate package manifest');
    dir = parent;
  }
  return {dir, ...JSON.parse(fs.readFileSync(path.join(dir, 'package.json')))};
}
for (const [arm, name, version] of specs) {
  const dir = path.resolve('bench-data/arms', arm);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'fixture-arm', version: '1.0.0', private: true}));
  npm(['install', '--prefix', dir, '--save-exact', '--ignore-scripts', `${name}@${version}`], `install-${arm}`);
  const require = createRequire(path.join(dir, 'package.json'));
  const coreEntry = require.resolve(name);
  const corePackage = packageAt(coreEntry);
  if (corePackage.name !== name || corePackage.version !== version) throw new Error('Core version mismatch');
  const direct = Object.entries(corePackage.dependencies || {}).filter(([key]) => key.includes('binding'));
  if (direct.length !== 1) throw new Error('Expected one binding dependency in core manifest');
  const bindingEntry = createRequire(coreEntry).resolve(direct[0][0]);
  const bindingPackage = packageAt(bindingEntry);
  const optionalDependencies = bindingPackage.optionalDependencies || {};
  const nativePackages = Object.entries(optionalDependencies).flatMap(([key, spec]) => {
    try {
      const pkg = packageAt(createRequire(bindingEntry).resolve(key));
      return [{name: key, spec, version: pkg.version, dir: pkg.dir}];
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      return [];
    }
  });
  if (nativePackages.length !== 1) throw new Error(`Expected one platform package, found ${nativePackages.length}`);
  const native = nativePackages[0];
  if (native.version !== version) throw new Error(`Native version mismatch ${native.version}`);
  require(name);
  const loaded = Object.keys(require.cache).filter(file => file.endsWith('.node'));
  const bindingPaths = loaded.filter(file => file.startsWith(native.dir + path.sep));
  if (bindingPaths.length !== 1) throw new Error(`Expected one loaded native package: ${JSON.stringify(loaded)}`);
  const bindingPath = fs.realpathSync(bindingPaths[0]);
  const sha256 = createHash('sha256').update(fs.readFileSync(bindingPath)).digest('hex');
  manifest[arm] = {name, version, dir, coreEntry, bindingDependency: direct[0], bindingPackage: {name: bindingPackage.name, version: bindingPackage.version, optionalDependencies}, native, bindingPath, sha256};
}
fs.writeFileSync(path.join(results, 'identity-manifest.json'), JSON.stringify(manifest, null, 2));
if (phase === 'S0' && manifest['OFFICIAL-229'].sha256 === manifest['CANARY-96dcd72d'].sha256) throw new Error('IDENTITY GATE: equal native hashes, no timing allowed');
npm(['install', '--prefix', path.resolve('bench-data/parser'), '--no-package-lock', '--ignore-scripts', 'acorn@8.15.0', 'escodegen@2.1.0'], 'install-parser');
console.log(JSON.stringify(manifest, null, 2));
