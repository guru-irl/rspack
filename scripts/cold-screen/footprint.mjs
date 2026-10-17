import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';

export function parseFootprint(data, pid) {
  if (data['bytes per unit'] !== 1 || data.unit !== 'byte') throw new Error('Footprint output is not in bytes');
  if (!Array.isArray(data.errors) || data.errors.length) throw new Error(`Footprint errors: ${JSON.stringify(data.errors)}`);
  if (!Array.isArray(data.processes) || data.processes.length !== 1 || data.processes[0].pid !== pid) throw new Error('Footprint target PID mismatch');
  const auxiliary = data.processes[0].auxiliary;
  const values = {
    physFootprint: auxiliary?.phys_footprint,
    peakPhysFootprint: auxiliary?.phys_footprint_peak,
    reclaimableBytes: data.summary?.total?.reclaimable,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0 || (key !== 'reclaimableBytes' && value === 0)) throw new Error(`Invalid footprint field: ${key}`);
  }
  if (values.peakPhysFootprint < values.physFootprint) throw new Error('Footprint peak is below current value');
  return {...values, warnings: data.warnings ?? []};
}

export function physicalFootprint(stem) {
  if (process.platform !== 'darwin') throw new Error('Physical-footprint probe requires macOS');
  const jsonPath = `${stem}.footprint.json`;
  const args = ['-p', String(process.pid), '-f', 'bytes', '-j', jsonPath];
  const started = new Date().toISOString();
  const start = performance.now();
  const child = spawnSync('/usr/bin/footprint', args, {encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024});
  const durationMs = performance.now() - start;
  const probe = {tool: '/usr/bin/footprint', args, pid: process.pid, started, durationMs, exitCode: child.status, error: child.error?.message};
  fs.writeFileSync(`${stem}.footprint.log`, `${child.stdout || ''}\n${child.stderr || ''}`);
  fs.writeFileSync(`${stem}.probe.json`, JSON.stringify(probe, null, 2));
  if (child.error || child.status !== 0) throw new Error(`Footprint probe failed: ${JSON.stringify(probe)}\n${child.stderr}`);
  return {...parseFootprint(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), process.pid), ...probe};
}

function selfTest() {
  const sample = {unit: 'byte', 'bytes per unit': 1, processes: [{pid: 42, auxiliary: {phys_footprint: 123456789, phys_footprint_peak: 234567890}}], errors: [], warnings: [], summary: {total: {reclaimable: 345678901}}};
  assert.equal(parseFootprint(sample, 42).physFootprint, 123456789);
  assert.throws(() => parseFootprint(sample, 43), /PID mismatch/);
  assert.throws(() => parseFootprint({...sample, errors: ['permission denied']}, 42), /Footprint errors/);
  assert.throws(() => parseFootprint({...sample, 'bytes per unit': 1024}, 42), /not in bytes/);
  assert.throws(() => parseFootprint({...sample, processes: [{pid: 42, auxiliary: {phys_footprint: 1}}]}, 42), /Invalid footprint field/);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selfTest();
  const stem = path.resolve('bench-data/results/footprint-preflight');
  const rssBeforeProbe = process.memoryUsage().rss;
  const result = physicalFootprint(stem);
  fs.writeFileSync(`${stem}.json`, JSON.stringify({rssBeforeProbe, ...result}, null, 2));
  console.log(JSON.stringify(result));
}
