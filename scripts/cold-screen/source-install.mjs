import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Expected macOS arm64');
const results = path.resolve('bench-data/results');
fs.mkdirSync(results, {recursive: true});
fs.writeFileSync(path.join(results, 'environment.json'), JSON.stringify({started: new Date().toISOString(), phase: 'SP', platform: process.platform, arch: process.arch, node: process.version, os: os.version(), release: os.release(), cpus: os.cpus(), ram: os.totalmem(), image: process.env.ImageOS, imageVersion: process.env.ImageVersion, commit: process.env.GITHUB_SHA}, null, 2));
const version = '2.2.10-canary-55a341bc-20261015175325';
const name = '@rspack-canary/core';
function npm(args, label) {
  const child = spawnSync('npm', [...args, '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'], {encoding: 'utf8', timeout: 240000});
  fs.writeFileSync(path.join(results, `${label}.log`), `${child.stdout || ''}\n${child.stderr || ''}`);
  if (child.error || child.status !== 0) throw new Error(`Install failed: ${label}`);
}
function packageDir(entry) {
  let dir = path.dirname(entry);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Missing manifest');
    dir = parent;
  }
  return dir;
}
const manifest = {};
for (const [arm, source, expected] of [['O', 'before', 'b7df6926fd6bc1ccbfb7c15e01df04600af19341'], ['D', 'after', '55a341bc4e30df2356720e5c1abae51d805c9c67']]) {
  const built = path.resolve('source-artifacts', `source-${source}`);
  const sourceCommit = fs.readFileSync(path.join(built, 'commit.txt'), 'utf8').trim();
  if (sourceCommit !== expected) throw new Error('Wrong built source commit');
  const dir = path.resolve('bench-data/arms', arm);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'fixture-arm', version: '1.0.0', private: true}));
  npm(['install', '--prefix', dir, '--save-exact', '--ignore-scripts', `${name}@${version}`], `install-${arm}`);
  const require = createRequire(path.join(dir, 'package.json'));
  const coreEntry = require.resolve(name);
  const coreDir = packageDir(coreEntry);
  const corePackage = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json')));
  const dependencies = Object.keys(corePackage.dependencies).filter(key => key.includes('binding'));
  if (dependencies.length !== 1) throw new Error('Expected one binding dependency');
  const bindingDir = packageDir(createRequire(coreEntry).resolve(dependencies[0]));
  for (const item of ['dist', 'compiled', 'hot']) {
    fs.rmSync(path.join(coreDir, item), {recursive: true, force: true});
    fs.cpSync(path.join(built, 'core', item), path.join(coreDir, item), {recursive: true});
  }
  const bindingPath = path.join(bindingDir, 'rspack.darwin-arm64.node');
  fs.copyFileSync(path.join(built, 'rspack.darwin-arm64.node'), bindingPath);
  fs.copyFileSync(path.join(built, 'binding.js'), path.join(bindingDir, 'binding.js'));
  const sha256 = createHash('sha256').update(fs.readFileSync(bindingPath)).digest('hex');
  require(name);
  const loaded = Object.keys(require.cache).filter(file => file.endsWith('.node') && file.startsWith(bindingDir + path.sep));
  if (loaded.length !== 1 || fs.realpathSync(loaded[0]) !== fs.realpathSync(bindingPath)) throw new Error('IDENTITY GATE: wrong source binding loaded');
  manifest[arm] = {name, version, dir, coreEntry, sourceCommit, profile: 'release', dependencyShell: `${name}@${version}`, bindingPath: fs.realpathSync(bindingPath), sha256};
}
fs.writeFileSync(path.join(results, 'identity-manifest.json'), JSON.stringify(manifest, null, 2));
if (manifest.O.sha256 === manifest.D.sha256) throw new Error('IDENTITY GATE: equal source native hashes');
npm(['install', '--prefix', path.resolve('bench-data/parser'), '--no-package-lock', '--ignore-scripts', 'acorn@8.15.0', 'escodegen@2.1.0'], 'install-parser');
console.log(JSON.stringify(manifest, null, 2));
