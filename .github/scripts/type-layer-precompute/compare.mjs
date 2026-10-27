import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hash } from './native.mjs';

const data = path.resolve('bench-data');
const results = path.join(data, 'results');
const scenarios = [['type', 'simple'], ['type', 'nested'], ['layer', 'nested'], ['type', 'none']];
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
};
function splitMs(sample) {
  const flatten = entries => entries.flatMap(entry => [entry, ...flatten(entry.children ?? [])]);
  const matches = Object.values(sample.splitLogs).flatMap(log => flatten(log.entries ?? [])).filter(entry => entry.type === 'time' && /^process cache groups: /.test(entry.message));
  assert.equal(matches.length, 1, 'Expected one SplitChunks process cache groups timer');
  const parsed = matches[0].message.match(/^process cache groups: ([0-9.]+) ms$/);
  assert(parsed, 'Unexpected SplitChunks timer format');
  const ms = Number(parsed[1]);
  assert(Number.isFinite(ms) && ms >= 0);
  return ms;
}

function summarize(records) {
  const summary = [];
  for (const [mode, pattern] of scenarios) {
    const versions = pattern === 'nested' && mode === 'type' ? ['parent', 'pr', 'fix', 'fix-no-precompute'] : ['parent', 'pr', 'fix'];
    const selected = records.filter(record => record.mode === mode && record.pattern.replace('-no-precompute', '') === pattern);
    assert.equal(selected.length, versions.length * 4, 'Incomplete process set');
    const assets = selected[0].assets;
    assert(assets.length > 0);
    for (const record of selected) assert.deepEqual(record.assets, assets, 'Final asset hashes differ');
    const rows = versions.map(version => {
      const processes = selected.filter(record => record.variant === version);
      assert.equal(processes.length, 4);
      for (const process of processes) {
        assert.equal(process.measurements.length, 6);
        assert(process.measurements.every(sample => Number.isFinite(sample.wallMs) && sample.wallMs > 0 && Number.isFinite(sample.cpuMs) && sample.cpuMs >= 0));
        assert(process.memory.peakRssKiB > 0 && process.memory.steadyRssKiB > 0);
        assert.equal(process.native.sha256, process.expectedSha256);
      }
      const samples = processes.flatMap(process => process.measurements);
      const walls = samples.map(sample => sample.wallMs);
      const split = samples.map(splitMs);
      const processWalls = processes.map(process => median(process.measurements.map(sample => sample.wallMs)));
      return { version, processes: processes.length, samples: samples.length, wallMs: median(walls), splitMs: median(split), cpuMs: median(samples.map(sample => sample.cpuMs)), peakRssMiB: median(processes.map(process => process.memory.peakRssKiB / 1024)), steadyRssMiB: median(processes.map(process => process.memory.steadyRssKiB / 1024)), processWallMediansMs: processWalls, wallRangeMs: [Math.min(...walls), Math.max(...walls)], splitRangeMs: [Math.min(...split), Math.max(...split)], peakRssPerProcessMiB: processes.map(process => process.memory.peakRssKiB / 1024) };
    });
    summary.push({ mode, pattern, assets, hashEquality: true, rows });
  }
  return summary;
}
function selfTest() {
  const record = (variant, mode, pattern, pair) => ({ variant, mode, pattern, pair, expectedSha256: 'abc', native: { sha256: 'abc' }, assets: [['main.js', 'abc']], memory: { peakRssKiB: 4096, steadyRssKiB: 2048 }, measurements: Array.from({ length: 6 }, () => ({ wallMs: 2, cpuMs: 1, splitLogs: { SplitChunks: { entries: [{ type: 'time', message: 'process cache groups: 1 ms' }] } } })) });
  const good = scenarios.flatMap(([mode, pattern]) => Array.from({ length: 4 }, (_, pair) => (mode === 'type' && pattern === 'nested' ? ['parent', 'pr', 'fix', 'fix-no-precompute'] : ['parent', 'pr', 'fix']).map(version => record(version, mode, version.endsWith('no-precompute') ? pattern + '-no-precompute' : pattern, pair))).flat());
  assert.equal(summarize(good)[0].rows[0].splitMs, 1);
  for (const mutate of [records => records.pop(), records => records[0].assets[0][1] = 'bad', records => records[0].assets[0][0] = 'other.js', records => records[0].native.sha256 = 'bad', records => records[0].measurements.pop(), records => records[0].measurements[0].splitLogs = {}]) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.throws(() => summarize(bad));
  }
  console.log('Comparator controls passed: missing process, changed hash, changed asset name, wrong binding, missing sample, missing timer');
}
if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}
selfTest();
fs.mkdirSync(results, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(data, 'bindings.json'), 'utf8'));
const records = [];
function run(version, mode, pattern, pair) {
  const bindingVersion = version === 'fix-no-precompute' ? 'fix' : version;
  const binding = manifest[bindingVersion];
  assert.equal(hash(binding.path), binding.sha256);
  const name = `${mode}-${pattern}-${pair}-${version}`;
  const child = spawnSync(process.execPath, [path.join(data, 'repro.mjs'), version, mode, pattern, '6'], { encoding: 'utf8', env: { ...process.env, RSPACK_BINDING: binding.path, EXPECTED_NATIVE_SHA: binding.sha256 }, maxBuffer: 128 * 1024 * 1024 });
  fs.writeFileSync(path.join(results, name + '.stdout'), child.stdout ?? '');
  fs.writeFileSync(path.join(results, name + '.stderr'), child.stderr ?? '');
  assert.equal(child.status, 0, `Process failed: ${name}: ${child.error ?? child.stderr}`);
  const record = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(record.variant, version);
  assert.equal(record.arch, process.env.EXPECTED_ARCH);
  record.pair = pair;
  record.expectedSha256 = binding.sha256;
  records.push(record);
  fs.writeFileSync(path.join(results, name + '.json'), JSON.stringify(record, null, 2));
  console.log(`${name}: ${median(record.measurements.map(sample => sample.wallMs)).toFixed(2)} ms`);
}
for (const [mode, pattern] of scenarios) {
  for (let pair = 0; pair < 4; pair++) {
    const versions = ['parent', 'pr', 'fix'];
    if (mode === 'type' && pattern === 'nested') versions.push('fix-no-precompute');
    if (pair % 2) versions.reverse();
    for (const version of versions) run(version, mode, version === 'fix-no-precompute' ? pattern + '-no-precompute' : pattern, pair);
  }
}
const summary = { platform: process.platform, arch: process.arch, node: process.version, run: process.env.GITHUB_RUN_ID, scenarios: summarize(records) };
fs.writeFileSync(path.join(results, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
