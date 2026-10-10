'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { generate } = require('./fixture.cjs');
const [baseArg, countArg, roundsArg] = process.argv.slice(2);
const base = path.resolve(baseArg);
const count = Number(countArg || 60000);
const rounds = Number(roundsArg || 7);
fs.mkdirSync(base, { recursive: true });
const project = path.join(base, 'project');
const results = path.join(base, 'results');
fs.mkdirSync(results, { recursive: true });
const fixture = generate(project, count);
fs.writeFileSync(path.join(results, 'metadata.json'), JSON.stringify({ fixture, rounds,
  node: process.version, cpu: os.cpus()[0].model, cpus: os.cpus().length, os: os.platform(), arch: os.arch(), release: os.release(),
  totalMemoryMiB: os.totalmem() / 1048576, runnerImage: process.env.ImageVersion, runId: process.env.GITHUB_RUN_ID, commit: process.env.GITHUB_SHA,
  order: 'Five-arm Latin rotation across rounds, alternating direction. Every arm is a fresh OS process with an empty persistent cache.',
}, null, 2));
const arms = count === 1000 ? ['NN', 'DD'] : ['DD', 'DN', 'ND', 'NN', 'DD2'];
const order = [];
for (let round = 0; round < rounds; round++) {
  let block = arms.map((_, i) => arms[(i + round) % arms.length]);
  if (round % 2) block = block.reverse();
  for (const arm of block) {
    const prefix = `${String(round).padStart(2, '0')}-${arm}`;
    const out = path.join(results, `${prefix}.json`);
    const log = fs.openSync(path.join(results, `${prefix}.stdout.log`), 'w');
    const err = fs.openSync(path.join(results, `${prefix}.stderr.log`), 'w');
    console.log(`START modules=${count} round=${round} arm=${arm} at=${new Date().toISOString()} load=${os.loadavg()}`);
    const before = { loadAverage: os.loadavg(), freeMemoryMiB: os.freemem() / 1048576 };
    const child = spawnSync(process.execPath, [path.join(__dirname, 'measure.cjs'), project, out, arm, String(round)], {
      stdio: ['ignore', log, err], timeout: 25 * 60 * 1000, env: process.env,
    });
    fs.closeSync(log); fs.closeSync(err);
    assert.equal(child.status, 0, `Failed ${prefix}: ${child.error || child.signal || child.status}. See preserved logs.`);
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    const measured = data.rows.filter(r => r.measured);
    assert.equal(measured.length, 3);
    assert(data.rows.every(r => r.editValidated && r.totalModules === count));
    if (count === 60000) assert(measured.every(r => r.totalChunks >= 2000 && r.totalChunks <= 5000));
    order.push({ round, arm, before, wallMs: measured.map(r => r.wallMs) });
    fs.writeFileSync(path.join(results, 'order.json'), JSON.stringify(order, null, 2));
    console.log(`DONE ${prefix} wall_ms=${measured.map(r => r.wallMs.toFixed(2)).join(',')}`);
  }
}
// Only after every result is recorded, discard disposable fixture outputs and cache.
fs.rmSync(path.join(project, 'cache'), { recursive: true, force: true });
fs.rmSync(path.join(project, 'dist'), { recursive: true, force: true });
console.log(`COMPLETE count=${count} processes=${order.length}`);
