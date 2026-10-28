'use strict';
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const v8 = require('node:v8');
exports.snapshot = function snapshot(phase) {
  assert.equal(process.platform, 'win32');
  const command = `$p = Get-Process -Id ${process.pid}; [pscustomobject]@{ privateBytes = $p.PrivateMemorySize64; workingSetBytes = $p.WorkingSet64; peakWorkingSetBytes = $p.PeakWorkingSet64; virtualBytes = $p.VirtualMemorySize64; handles = $p.HandleCount; threads = $p.Threads.Count } | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const win = JSON.parse(result.stdout.trim());
  for (const key of ['privateBytes', 'workingSetBytes', 'handles']) assert(win[key] > 0, key);
  const node = process.memoryUsage();
  const row = {phase, elapsedMs: performance.now(), ...win, node, v8: v8.getHeapStatistics()};
  console.log(JSON.stringify({kind: 'memory-snapshot', ...row}));
  return row;
};
