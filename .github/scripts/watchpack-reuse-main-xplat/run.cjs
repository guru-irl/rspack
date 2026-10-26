const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const work = path.join(root, 'bench-data');
const results = path.join(work, 'results');
const scripts = __dirname;
const core = path.join(root, 'packages/rspack');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const main = process.env.MAIN_SHA;
const feature = process.env.FEATURE_SHA;
assert.equal(process.platform, process.env.EXPECTED_PLATFORM);
assert.equal(process.arch, process.env.EXPECTED_ARCH);
assert.match(main, /^[a-f0-9]{40}$/);
assert.match(feature, /^[a-f0-9]{40}$/);
fs.mkdirSync(results, { recursive: true });

function command(program, args, log, env = {}) {
  const fd = fs.openSync(path.join(results, log), 'w');
  try {
    const child = spawnSync(program, args, {
      cwd: root,
      env: { ...process.env, ...env },
      shell: process.platform === 'win32' && program === 'pnpm',
      stdio: ['ignore', fd, fd],
      timeout: 25 * 60 * 1000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${program} failed; see ${log}`);
  } finally {
    fs.closeSync(fd);
  }
}
function git(args) {
  const child = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}
function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    const file = path.join(dir, item.name);
    return item.isDirectory() ? filesIn(file) : [file];
  });
}

const metadata = JSON.parse(fs.readFileSync(path.join(work, 'artifacts.json'), 'utf8'));
const artifact = metadata.artifacts.find(item => item.name === process.env.BINDING_ARTIFACT);
assert(artifact && !artifact.expired);
assert.equal(artifact.workflow_run.head_sha, main);
const binaries = filesIn(path.join(work, 'native')).filter(file => file.endsWith('.node'));
assert.equal(binaries.length, 1);
const native = path.join(root, 'crates/node_binding', path.basename(binaries[0]));
fs.copyFileSync(binaries[0], native);
const nativeSha256 = hash(fs.readFileSync(native));
const sourceFiles = [
  'packages/rspack/src/node/NodeWatchFileSystem.ts',
  'packages/rspack/src/node/NodeEnvironmentPlugin.ts',
];
for (const file of sourceFiles) {
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'), git(['show', `${feature}:${file}`]).replace(/\r\n/g, '\n'));
}
const originals = new Map(sourceFiles.map(file => [file, fs.readFileSync(path.join(root, file))]));
const watchingPath = path.join(core, 'src/Watching.ts');
const watching = fs.readFileSync(watchingPath, 'utf8');
let instrumented = watching;
for (const [field, kind] of [['fileDependencies', 'files'], ['contextDependencies', 'directories'], ['missingDependencies', 'missing']]) {
  const declaration = `          const ${field} = new Set([`;
  const assignment = `          ${field}.added = `;
  assert.equal(instrumented.split(declaration).length, 2);
  assert.equal(instrumented.split(assignment).length, 2);
  instrumented = instrumented.replace(declaration, `          const ${kind}MaterializationStart = performance.now();\n${declaration}`);
  instrumented = instrumented.replace(assignment, `          (globalThis as any).__watchpackMaterialization?.('${kind}', performance.now() - ${kind}MaterializationStart);\n${assignment}`);
}
const receipt = {
  main, feature, workflowHead: git(['rev-parse', 'HEAD']).trim(),
  platform: process.platform, arch: process.arch, node: process.version,
  artifact: artifact.name, nativeSha256,
  fixture: 'a4ca7fd6ff8bc31a48de4ef91922fcb1af1e53dc',
  fixtureGeneratorSha256: hash(fs.readFileSync(path.join(scripts, 'prepare.mjs'))),
};
fs.writeFileSync(path.join(results, 'provenance.json'), JSON.stringify(receipt, null, 2));
command('pnpm', ['--filter', '@rspack/core', 'exec', 'prebundle'], 'prebundle.log');
command('pnpm', ['--filter', '@rspack/core', 'exec', 'node', 'move-tinypool.js'], 'tinypool.log');
try {
  fs.writeFileSync(watchingPath, instrumented);
  for (const arm of ['MAIN', 'PR']) {
    for (const file of sourceFiles) {
      fs.writeFileSync(path.join(root, file), arm === 'MAIN' ? git(['show', `${main}:${file}`]) : originals.get(file));
    }
    command('pnpm', ['--filter', '@rspack/core', 'build'], `${arm}-build.log`);
    const snapshot = path.join(work, 'cores', arm);
    fs.mkdirSync(snapshot, { recursive: true });
    fs.cpSync(path.join(core, 'dist'), path.join(snapshot, 'dist'), { recursive: true });
    fs.copyFileSync(path.join(core, 'package.json'), path.join(snapshot, 'package.json'));
    fs.symlinkSync(path.join(core, 'compiled'), path.join(snapshot, 'compiled'), 'junction');
    fs.symlinkSync(path.join(core, 'node_modules'), path.join(snapshot, 'node_modules'), 'junction');
  }
} finally {
  fs.writeFileSync(watchingPath, watching);
  for (const [file, bytes] of originals) fs.writeFileSync(path.join(root, file), bytes);
}
fs.mkdirSync(path.join(work, 'parser'), { recursive: true });
command('pnpm', ['--dir', 'bench-data/parser', 'add', '--ignore-workspace', '--ignore-scripts', '--save-exact', 'acorn@8.15.0', 'escodegen@2.1.0'], 'parser-install.log');
command(process.execPath, [path.join(scripts, 'prepare.mjs'), path.join(work, 'fixture')], 'fixture.log');
for (const pair of [1, 2, 3]) {
  for (const arm of ['MAIN', 'PR']) {
    const result = path.join(results, `pair-${pair}-${arm}`);
    fs.mkdirSync(result, { recursive: true });
    command(process.execPath, [path.join(scripts, 'timing.cjs')], `pair-${pair}-${arm}.log`, {
      CORE_ENTRY: path.join(work, 'cores', arm, 'dist/index.js'),
      RESULT_DIR: result,
      FIXTURE_ROOT: path.join(work, 'fixture'),
      TIMING_ARM: arm,
      EXPECTED_BINDING_PATH: native,
      EXPECTED_BINDING_SHA: nativeSha256,
    });
  }
}
command(process.execPath, [path.join(scripts, 'audit.cjs'), results], 'audit.log');
console.log(fs.readFileSync(path.join(results, 'summary.json'), 'utf8'));
