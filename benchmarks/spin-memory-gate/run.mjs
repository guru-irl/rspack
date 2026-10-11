import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const out = path.resolve(process.argv[2] || '.spider/scratch/spin-memory-gate/results');
const fixture = path.join(out, 'fixture');
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env };
delete env.RSPACK_RAYON_SPIN_ROUNDS;
delete env.RSPACK_RAYON_SPIN_MODE;
// Retain the platform's normal pool sizes, identical for every launch.
const launch = (file, args, childEnv, log) => new Promise((resolve, reject) => {
  const fd = fs.openSync(log, 'w');
  const cp = spawn(process.execPath, [path.join(here, file), ...args], { env: childEnv, stdio: ['ignore', fd, fd] });
  const timer = setTimeout(() => cp.kill(), 3600000);
  cp.on('error', error => { clearTimeout(timer); fs.closeSync(fd); reject(error); });
  cp.on('close', (code, signal) => {
    clearTimeout(timer); fs.closeSync(fd);
    if (code !== 0 || signal) reject(new Error(`${file} failed: code=${code} signal=${signal}; log=${log}`));
    else resolve();
  });
});
const binaries = fs.readdirSync(path.join(repo, 'crates/node_binding')).filter(x => x.endsWith('.node'));
if (binaries.length !== 1) throw new Error(`Expected exactly one local binding: ${binaries}`);
const binding = binaries[0];
const bindingSha256 = createHash('sha256').update(fs.readFileSync(path.join(repo, 'crates/node_binding', binding))).digest('hex');
const metadata = { schema: 1, branchSha: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null, runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  runner: process.env.RUNNER_OS || process.platform, binding, bindingSha256, fixtureModules: 60000,
  records: [] };
const schedule = ['OFF', 'SPIN', 'AA1', 'AA2'].map(arm => ({ arm, warmup: true, pair: null, family: 'warmup' }));
for (let pair = 1; pair <= 10; pair++) {
  const treatment = (pair % 2 ? ['OFF', 'SPIN'] : ['SPIN', 'OFF']).map(arm => ({ arm, pair, family: 'spin', warmup: false }));
  const control = (pair % 2 ? ['AA1', 'AA2'] : ['AA2', 'AA1']).map(arm => ({ arm, pair, family: 'aa', warmup: false }));
  schedule.push(...(pair % 2 ? [...treatment, ...control] : [...control, ...treatment]));
}
await launch('generate.mjs', [], { ...env, SPIN_MEMORY_FIXTURE: fixture }, path.join(out, 'generate.log'));
for (const [index, item] of schedule.entries()) {
  const name = `${String(index).padStart(2, '0')}-${item.family}-${item.pair || 0}-${item.arm}`;
  const childEnv = { ...env };
  if (item.arm === 'SPIN') {
    childEnv.RSPACK_RAYON_SPIN_ROUNDS = '2048';
    childEnv.RSPACK_RAYON_SPIN_MODE = 'yield';
  }
  const json = path.join(out, name + '.json');
  await launch('launch.mjs', [fixture, path.join(repo, 'packages/rspack'), json], childEnv, path.join(out, name + '.log'));
  const sample = JSON.parse(fs.readFileSync(json, 'utf8'));
  if (!sample.success) throw new Error(`Invalid sample ${json}`);
  metadata.records.push({ ...item, index, file: path.basename(json), sample });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(`${name}: peak=${sample.peakRssMiB.toFixed(2)} MiB steady=${sample.steadyRssMiB.toFixed(2)} MiB cpu=${sample.cpuSeconds.toFixed(2)}s`);
}
metadata.complete = true;
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(metadata, null, 2) + '\n');
