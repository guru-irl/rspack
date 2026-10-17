import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonicalEmission} from './emission.mjs';
const raw = path.resolve(process.env.CPU_SCALING_RAW ?? 'bench-data/cpu-scaling-raw');
fs.mkdirSync(raw, {recursive: true});
const root = path.resolve('bench-data/fixture');
const manifestPath = path.resolve('bench-data/results/identity-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath));
const arm = 'OFFICIAL-229';
const attempts = [], schedule = [], parity = new Map(), normalized = {};
let referenceShape, referenceCanonical;
const save = (name, data) => fs.writeFileSync(path.join(raw, name), JSON.stringify(data, null, 2));
function preflight(series) {
  const r = spawnSync('bash', ['-lc', 'set -euo pipefail; . ~/src/rspack-env.sh; date -u +%FT%TZ; nproc; lscpu; pgrep -a cargo || true; pgrep -a node || true; cat /proc/loadavg; df -h ~'], {encoding: 'utf8'});
  fs.writeFileSync(path.join(raw, `${series}-machine.txt`), r.stdout + r.stderr);
  if (r.status !== 0) throw new Error('Preflight failed');
  for (const name of ['cargo', 'rustc', 'node', 'nodejs']) {
    const p = spawnSync('pgrep', ['-x', name], {encoding: 'utf8'});
    if (![0, 1].includes(p.status)) throw new Error(`pgrep failed: ${name}`);
    const foreign = p.stdout.trim().split(/\s+/).filter(Boolean).map(Number).filter(pid => pid !== process.pid);
    if (foreign.length) throw new Error(`Foreign heavy processes: ${name} ${foreign}`);
  }
}
function run(series, cell, core, knob, label, round = 0, diagnostic = false, wrongIdentity = false) {
  const deadline = Date.parse(series === 'phase1' ? '2026-10-17T20:44:00Z' : '2026-10-17T21:17:00Z');
  if (Date.now() >= deadline) throw new Error('Measurement deadline reached');
  fs.rmSync(path.join(root, 'out'), {recursive: true, force: true});
  const stem = `${series}-${cell}-${core}-${knob}-${label}`;
  const resultPath = path.join(raw, `${stem}.json`);
  const env = {...process.env, ARM_MANIFEST: manifestPath, ARM: arm, CELL: cell, DIAGNOSTIC: diagnostic ? '1' : '0', BINDING_PATH: manifest[arm].bindingPath, EXPECTED_BINDING_SHA256: wrongIdentity ? '0'.repeat(64) : manifest[arm].sha256};
  delete env.RAYON_NUM_THREADS; delete env.TOKIO_WORKER_THREADS;
  if (knob === 'rayon4' || knob === 'both4') env.RAYON_NUM_THREADS = '4';
  if (knob === 'tokio4' || knob === 'both4') env.TOKIO_WORKER_THREADS = '4';
  const args = ['--expose-gc', '--max-old-space-size=8192', 'scripts/program-native/run.mjs', root, resultPath];
  const command = core === 'C4' ? 'taskset' : process.execPath;
  const commandArgs = core === 'C4' ? ['-c', '0-3', process.execPath, ...args] : args;
  const attempt = {started: new Date().toISOString(), series, cell, core, knob, label, round, diagnostic, wrongIdentity, file: path.basename(resultPath)};
  attempts.push(attempt); save('attempts.json', attempts);
  const child = spawnSync(command, commandArgs, {encoding: 'utf8', env, timeout: Math.min(180000, deadline - Date.now()), maxBuffer: 32 * 1024 * 1024});
  attempt.finished = new Date().toISOString(); attempt.exitCode = child.status; attempt.signal = child.signal; attempt.error = child.error?.message;
  fs.writeFileSync(path.join(raw, `${stem}.log`), `${child.stdout || ''}\n${child.stderr || ''}`);
  save('attempts.json', attempts);
  if (wrongIdentity) {
    if (child.status === 0 || !child.stderr?.includes('Loaded binding does not match its arm manifest')) throw new Error('IDENTITY GATE: negative check failed');
    console.log('Negative identity gate rejected incorrect hash'); return;
  }
  if (child.error || child.status !== 0) throw new Error(`Failed process ${stem}: ${child.error?.message || ''} ${child.stderr}`);
  const result = JSON.parse(fs.readFileSync(resultPath));
  if (result.bindingSha256 !== manifest[arm].sha256 || !result.bindingIdentity.verifiedInRequireCache || !result.bindingIdentity.verifiedInMaps) throw new Error('IDENTITY GATE: loaded binding mismatch');
  if (result.errorCount !== 0 || result.moduleCount !== 60701) throw new Error('Invalid module/error count');
  const signature = JSON.stringify(result.outputFiles);
  if (parity.has(cell) && parity.get(cell) !== signature) throw new Error(`PARITY GATE: nondeterministic output within ${cell}`);
  const shape = JSON.stringify({moduleCount: result.moduleCount, files: result.outputFiles.map(({name, bytes}) => ({name, bytes}))});
  referenceShape ??= shape;
  if (shape !== referenceShape) throw new Error('PARITY GATE: cross-cell emitted bytes/module count differs');
  if (diagnostic) {
    const canonical = canonicalEmission(path.join(root, 'out/bundle.cjs'));
    normalized[cell] = canonical; save('normalized-parity.json', normalized);
    const value = JSON.stringify(canonical); referenceCanonical ??= value;
    if (value !== referenceCanonical) throw new Error('PARITY GATE: cross-cell module code/runtime differs');
  }
  parity.set(cell, signature); save('parity.json', Object.fromEntries([...parity].map(([key, value]) => [key, JSON.parse(value)])));
  const counts = Object.fromEntries(Object.entries(result.threads.groups).map(([name, g]) => [name, g.endCount]));
  const expectedRayon = core === 'C4' || ['rayon4', 'both4'].includes(knob) ? 4 : 16;
  if (result.availableParallelism !== (core === 'C4' ? 4 : 16) || counts.rayon !== expectedRayon) throw new Error(`POOL GATE: affinity/rayon not resized: ${JSON.stringify({counts, expectedRayon, parallelism: result.availableParallelism})}`);
  if (result.threads.exitedThreads.length) throw new Error('Thread exited during measurement; CPU accounting incomplete');
  schedule.push({...attempt, counts, warmup: label === 'warmup'}); save('schedule.json', schedule);
  console.log(JSON.stringify({stem, round, buildMs: result.buildMs, processCoreSeconds: (result.processCpuUs.user + result.processCpuUs.system) / 1e6, counts}));
  return result;
}
const median = a => {const b = [...a].sort((a,b)=>a-b); return (b[Math.floor((b.length-1)/2)] + b[Math.ceil((b.length-1)/2)])/2;};
const results = series => schedule.filter(x => x.series === series && x.round > 0).map(x => ({...x, result: JSON.parse(fs.readFileSync(path.join(raw, x.file)))}));
const cpu = x => (x.result.processCpuUs.user + x.result.processCpuUs.system) / 1e6;
function validatePools() {
  for (const cell of ['K0', 'K1']) {
    const a = schedule.find(x=>x.series === 'phase1' && x.cell===cell && x.core==='C16' && x.label==='warmup');
    const b = schedule.find(x=>x.series === 'phase1' && x.cell===cell && x.core==='C4' && x.label==='warmup');
    if (!a || !b || a.counts['rspack-tokio'] <= b.counts['rspack-tokio']) throw new Error(`POOL GATE: tokio did not shrink under taskset for ${cell}: ${JSON.stringify({a:a?.counts,b:b?.counts})}`);
  }
}
try {
  save('protocol.json', {started: new Date().toISOString(), rounds: 8, warmups: 'one per combination/arm', ordering: 'left-rotate four arms by round minus one', phase1Deadline: '2026-10-17T20:44:00Z', phase2Deadline: '2026-10-17T21:17:00Z', hardStop: '2026-10-17T22:00:00Z', clockTicks: process.env.CLOCK_TICKS});
  preflight('phase1');
  run('phase1', 'K0', 'C16', 'default', 'negative-identity', 0, false, true);
  for (const cell of ['K0', 'K1']) run('phase1', cell, 'C16', 'default', 'diagnostic', 0, true);
  const combinations = [['K0','C16'],['K0','C4'],['K1','C16'],['K1','C4']];
  for (const [cell, core] of combinations) run('phase1', cell, core, 'default', 'warmup');
  validatePools();
  for (let round=1; round<=8; round++) {
    const rotation=(round-1)%4;
    for (const [cell, core] of [...combinations.slice(rotation),...combinations.slice(0,rotation)]) run('phase1', cell, core, 'default', `round-${round}`, round);
  }
  const rows=results('phase1');
  const medians=Object.fromEntries(combinations.map(([cell,core])=>[`${cell}-${core}`, median(rows.filter(x=>x.cell===cell&&x.core===core).map(cpu))]));
  const excess=medians['K0-C16'] > 1.1*medians['K0-C4'];
  const drop4=medians['K1-C4']-medians['K0-C4'], drop16=medians['K1-C16']-medians['K0-C16'];
  const trigger={medians, k0Over10Percent: excess, drop4, drop16, dropShrinksOrReverses: drop16 < drop4, runPhase2: excess || drop16 < drop4, finished: new Date().toISOString()};
  save('phase1-complete.json',trigger);
  console.log('PHASE1_COMPLETE '+JSON.stringify(trigger));
  if (trigger.runPhase2) {
    // K0 directly tests excess on the Rust-bound cell. Include K1 if the full series fits with a five-minute margin.
    for (const cell of ['K0','K1']) {
      if (cell==='K1' && Date.now() > Date.parse('2026-10-17T21:00:00Z')) {save('phase2-K1-skipped.json',{reason:'time budget', at:new Date().toISOString()}); break;}
      preflight(`phase2-${cell}`);
      const knobs=['default','rayon4','tokio4','both4'];
      const warmups=[];
      for (const knob of knobs) warmups.push(run('phase2',cell,'C16',knob,'warmup'));
      const count=r=>r.threads.groups['rspack-tokio'].startCount;
      if (count(warmups[2]) !== 4 || count(warmups[3]) !== 4 || count(warmups[0]) <= 4) throw new Error(`POOL GATE: TOKIO_WORKER_THREADS did not resize workers: ${JSON.stringify(warmups.map(r=>r.threads.groups['rspack-tokio']))}`);
      for (let round=1; round<=8; round++) {
        const rotation=(round-1)%4;
        for (const knob of [...knobs.slice(rotation),...knobs.slice(0,rotation)]) run('phase2',cell,'C16',knob,`round-${round}`,round);
      }
      save(`phase2-${cell}-complete.json`,{finished:new Date().toISOString()});
    }
  }
  save('complete.json',{finished:new Date().toISOString(),successfulProcesses:schedule.length,trigger});
} catch(error) {
  save('failure.json',{at:new Date().toISOString(),message:error.message,stack:error.stack});
  console.error(error.stack); process.exitCode=1;
}
