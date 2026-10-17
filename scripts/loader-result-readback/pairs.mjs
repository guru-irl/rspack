import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(process.env.FIXTURE_ROOT || 'bench-data/fixture');
const results = path.resolve(process.env.RESULTS_ROOT || 'bench-data/results');
fs.mkdirSync(results, {recursive: true});
const jsRoot = path.resolve('packages/rspack/dist');
const expectedCore = {};
const binding = path.resolve(process.env.BINDING_PATH);
const expected = {};
let parity;
const schedule = [];
const orders = [['base1', 'base2', 'pr1', 'pr2'], ['pr2', 'pr1', 'base2', 'base1'], ['base2', 'pr2', 'pr1', 'base1'], ['pr1', 'base1', 'base2', 'pr2']];
fs.writeFileSync(path.join(results, 'protocol.json'), JSON.stringify({platform: process.platform, blocks: 10, warmups: ['base', 'pr'], orders, deadline: '2026-10-17T21:20:00Z'}, null, 2));
for (const arm of ['base', 'pr']) {
  const file = path.resolve(`bench-data/bindings/${arm}.node`);
  expected[arm] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  expectedCore[arm] = createHash('sha256').update(fs.readFileSync(`bench-data/js/${arm}/index.js`)).digest('hex');
}
fs.writeFileSync(path.join(results, 'identity-manifest.json'), JSON.stringify(expected, null, 2));
fs.writeFileSync(path.join(results, 'core-manifest.json'), JSON.stringify(expectedCore, null, 2));
if (expectedCore.base === expectedCore.pr) throw new Error('JavaScript core artifacts are equal');
if (expected.base === expected.pr) throw new Error('Base and PR binding hashes are equal; no timing is allowed');
function run(arm, label, family = arm, block = 0) {
  if (Date.now() >= Date.parse('2026-10-17T21:20:00Z')) throw new Error('Measurement deadline reached');
  fs.copyFileSync(`bench-data/bindings/${arm}.node`, binding);
  fs.rmSync(jsRoot, {recursive: true, force: true});
  fs.cpSync(`bench-data/js/${arm}`, jsRoot, {recursive: true});
  fs.rmSync(path.join(root, 'out'), {recursive: true, force: true});
  const resultPath = path.join(results, `${label}-${arm}.json`);
  const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=8192', 'scripts/program-native/run.mjs', root, resultPath], {encoding: 'utf8', timeout: 180000, env: {...process.env, EXPECTED_BINDING_SHA256: expected[arm], EXPECTED_CORE_SHA256: expectedCore[arm]}});
  fs.writeFileSync(path.join(results, `${label}-${arm}.log`), `${child.stdout || ''}\n${child.stderr || ''}`);
  if (child.error || child.status !== 0) throw new Error(`Failed command ${label}/${arm}: ${child.stderr}\n${child.stdout}`);
  const result = JSON.parse(fs.readFileSync(resultPath));
  if (result.bindingSha256 !== expected[arm] || !result.bindingIdentity.verifiedInRequireCache || (process.platform === 'linux' && !result.bindingIdentity.verifiedInMaps)) throw new Error('Loaded binding identity mismatch');
  if (result.coreSha256 !== expectedCore[arm]) throw new Error('JavaScript core identity mismatch');
  const files = JSON.stringify(result.outputFiles);
  parity ??= files;
  if (files !== parity) throw new Error(`Output mismatch: ${label}/${arm}`);
  schedule.push({label, arm, family, block, file: path.basename(resultPath)});
  fs.writeFileSync(path.join(results, 'schedule.json'), JSON.stringify(schedule, null, 2));
  console.log(JSON.stringify({label, arm, family, block, buildMs: result.buildMs, mainCpuMs: result.mainCpuMs, peakRss: result.peakRss, endRss: result.steadyRss}));
}
run('base', 'warmup');
run('pr', 'warmup');
for (let block = 1; block <= 10; block++) {
  if (process.platform === 'win32') {
    for (const family of orders[(block - 1) % orders.length]) {
      const arm = family.startsWith('base') ? 'base' : 'pr';
      run(arm, `block-${block}-${family}`, family, block);
    }
  } else {
    for (const arm of block % 2 ? ['base', 'pr'] : ['pr', 'base']) run(arm, `pair-${block}`, arm, block);
  }
}
fs.writeFileSync(path.join(results, 'parity.json'), JSON.stringify({bindings: expected, identical: true, runs: schedule.length, files: JSON.parse(parity)}, null, 2));
