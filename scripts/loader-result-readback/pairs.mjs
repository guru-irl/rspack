import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve('bench-data/fixture');
const results = path.resolve('bench-data/results');
const binding = path.resolve(process.env.BINDING_PATH);
const expected = {};
let parity;
for (const arm of ['base', 'pr']) {
  const file = path.resolve(`bench-data/bindings/${arm}.node`);
  expected[arm] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
fs.writeFileSync(path.join(results, 'identity-manifest.json'), JSON.stringify(expected, null, 2));
if (expected.base === expected.pr) throw new Error('Base and PR binding hashes are equal; no timing is allowed');
function run(arm, label) {
  fs.copyFileSync(`bench-data/bindings/${arm}.node`, binding);
  fs.rmSync(path.join(root, 'out'), {recursive: true, force: true});
  const resultPath = path.join(results, `${label}-${arm}.json`);
  const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=8192', 'scripts/program-native/run.mjs', root, resultPath], {encoding: 'utf8', env: {...process.env, EXPECTED_BINDING_SHA256: expected[arm]}});
  fs.writeFileSync(path.join(results, `${label}-${arm}.log`), `${child.stdout || ''}\n${child.stderr || ''}`);
  if (child.status !== 0) throw new Error(`Failed command ${label}/${arm}: ${child.stderr}\n${child.stdout}`);
  const result = JSON.parse(fs.readFileSync(resultPath));
  if (result.bindingSha256 !== expected[arm] || !result.bindingIdentity.verifiedInRequireCache || (process.platform === 'linux' && !result.bindingIdentity.verifiedInMaps)) throw new Error('Loaded binding identity mismatch');
  const files = JSON.stringify(result.outputFiles);
  parity ??= files;
  if (files !== parity) throw new Error(`Output mismatch: ${label}/${arm}`);
  console.log(JSON.stringify({label, arm, buildMs: result.buildMs, mainCpuMs: result.mainCpuMs, peakRss: result.peakRss, endRss: result.steadyRss}));
}
run('base', 'warmup');
run('pr', 'warmup');
for (let pair = 1; pair <= 10; pair++) {
  for (const arm of pair % 2 ? ['base', 'pr'] : ['pr', 'base']) run(arm, `pair-${pair}`);
}
fs.writeFileSync(path.join(results, 'parity.json'), JSON.stringify({bindings: expected, identical: true, runs: 22, files: JSON.parse(parity)}, null, 2));
