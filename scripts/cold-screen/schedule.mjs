import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {cells, memoryCells} from './layout.mjs';

const phase = process.argv[2];
if (!['S0', 'S1'].includes(phase)) throw new Error('Expected S0 or S1');
const root = path.resolve('bench-data/fixture');
const results = path.resolve('bench-data/results');
const manifestPath = path.join(results, 'identity-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath));
const schedule = [];
const attempts = [];
const parity = new Map();
const deadline = Date.parse('2026-10-17T21:20:00Z');
const selectedCells = process.platform === 'linux' ? cells : memoryCells;
fs.writeFileSync(path.join(results, 'protocol.json'), JSON.stringify({phase, platform: process.platform, cells: selectedCells, rounds: phase === 'S1' ? 5 : 10, warmups: phase === 'S1' ? 'one per cell' : ['OFFICIAL-229', 'CANARY-96dcd72d'], deadline: new Date(deadline).toISOString()}, null, 2));
function run(arm, cell, label, round = 0, diagnostic = false, wrongIdentity = false) {
  if (Date.now() >= deadline) throw new Error('Hard measurement deadline reached');
  fs.rmSync(path.join(root, 'out'), {recursive: true, force: true});
  const stem = `${label}-${cell || arm}`;
  const resultPath = path.join(results, `${stem}.json`);
  const attempt = {started: new Date().toISOString(), phase, arm, cell, label, round, diagnostic, wrongIdentity, file: path.basename(resultPath)};
  attempts.push(attempt);
  fs.writeFileSync(path.join(results, 'attempts.json'), JSON.stringify(attempts, null, 2));
  const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=8192', 'scripts/program-native/run.mjs', root, resultPath], {encoding: 'utf8', timeout: 180000, env: {...process.env, ARM_MANIFEST: manifestPath, ARM: arm, CELL: cell || '', DIAGNOSTIC: diagnostic ? '1' : '0', BINDING_PATH: manifest[arm].bindingPath, EXPECTED_BINDING_SHA256: wrongIdentity ? '0'.repeat(64) : manifest[arm].sha256}});
  attempt.finished = new Date().toISOString();
  attempt.exitCode = child.status;
  attempt.error = child.error?.message;
  fs.writeFileSync(path.join(results, `${stem}.log`), `${child.stdout || ''}\n${child.stderr || ''}`);
  fs.writeFileSync(path.join(results, 'attempts.json'), JSON.stringify(attempts, null, 2));
  if (wrongIdentity) {
    if (child.status === 0 || !child.stderr?.includes('Loaded binding does not match its arm manifest')) throw new Error('Negative identity check did not reject an incorrect expected hash');
    console.log('Negative identity gate passed');
    return;
  }
  if (child.error || child.status !== 0) throw new Error(`Failed process ${stem}: ${child.stderr}\n${child.stdout}`);
  const result = JSON.parse(fs.readFileSync(resultPath));
  if (result.bindingSha256 !== manifest[arm].sha256 || !result.bindingIdentity.verifiedInRequireCache || (process.platform === 'linux' && !result.bindingIdentity.verifiedInMaps)) throw new Error('IDENTITY GATE: loaded binding mismatch');
  if (result.errorCount !== 0 || result.moduleCount !== 60701) throw new Error('Invalid build result');
  const signature = JSON.stringify(result.outputFiles);
  const parityKey = phase === 'S1' ? 'all-cells' : arm;
  if (parity.has(parityKey) && parity.get(parityKey) !== signature) throw new Error(`Output mismatch within ${parityKey}`);
  parity.set(parityKey, signature);
  schedule.push({...attempt, warmup: label === 'warmup'});
  fs.writeFileSync(path.join(results, 'schedule.json'), JSON.stringify(schedule, null, 2));
  fs.writeFileSync(path.join(results, 'parity.json'), JSON.stringify(Object.fromEntries([...parity].map(([key, value]) => [key, JSON.parse(value)])), null, 2));
  console.log(JSON.stringify({label, arm, cell, round, diagnostic, buildMs: result.buildMs, mainCpuMs: result.mainCpuMs, peakRss: result.peakRss, endRss: result.steadyRss}));
}
if (phase === 'S0' && manifest['OFFICIAL-229'].sha256 === manifest['CANARY-96dcd72d'].sha256) throw new Error('IDENTITY GATE: equal arm hashes');
run('OFFICIAL-229', phase === 'S1' ? 'K0' : null, 'negative-identity', 0, false, true);
if (phase === 'S1') {
  for (const cell of selectedCells) run('OFFICIAL-229', cell, 'diagnostic', 0, true);
  fs.writeFileSync(path.join(results, 'diagnostics-complete.json'), JSON.stringify({cells: selectedCells, finished: new Date().toISOString()}));
  for (const cell of selectedCells) run('OFFICIAL-229', cell, 'warmup');
  for (let round = 1; round <= 5; round++) {
    const rotation = (round - 1) % selectedCells.length;
    for (const cell of [...selectedCells.slice(rotation), ...selectedCells.slice(0, rotation)]) run('OFFICIAL-229', cell, `round-${round}`, round);
  }
} else {
  for (const arm of ['OFFICIAL-229', 'CANARY-96dcd72d']) run(arm, null, 'warmup');
  for (let round = 1; round <= 10; round++) {
    for (const arm of round % 2 ? ['OFFICIAL-229', 'CANARY-96dcd72d'] : ['CANARY-96dcd72d', 'OFFICIAL-229']) run(arm, null, `pair-${round}`, round);
  }
}
fs.writeFileSync(path.join(results, 'complete.json'), JSON.stringify({phase, finished: new Date().toISOString(), successfulProcesses: schedule.length}));
