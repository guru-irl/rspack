'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2]);
const units = {B: 1, KiB: 2**10, MiB: 2**20, GiB: 2**30, TiB: 2**40};
function median(a) { a = [...a].sort((a,b) => a-b); assert(a.length); return a[(a.length-1)/2]; }
const rows = [];
for (const name of fs.readdirSync(root).filter(n => /^(base|final)-memory-[1-5]\.log$/.test(n))) {
  const text = fs.readFileSync(path.join(root, name), 'utf8');
  const sample = JSON.parse(fs.readFileSync(path.join(root, name.replace(/\.log$/, '.json')), 'utf8'));
  const line = text.split(/\r?\n/).find(s => /^\s*committed:/.test(s));
  assert(line, `allocator committed stats required: ${name}`);
  const matches = [...line.matchAll(/([0-9.]+)\s+(B|KiB|MiB|GiB|TiB)/g)].map(m => Number(m[1]) * units[m[2]]);
  assert.equal(matches.length, 3, line);
  const effective = text.split(/\r?\n/).find(s => /option.*purge_delay/.test(s));
  if (process.env.MEMORY_ALLOCATOR_POLICY) {
    assert(effective, 'effective purge option required');
    const value = Number(effective.trim().match(/(-?\d+)\s*$/)?.[1]);
    assert.equal(value, Number(process.env.MIMALLOC_PURGE_DELAY), effective);
  }
  rows.push({arm: sample.arm, rep: sample.rep, policy: sample.allocatorPolicy, peakCommittedMiB: matches[0]/2**20, totalCommittedMiB: matches[1]/2**20, exitCommittedMiB: matches[2]/2**20, effective});
}
assert.equal(rows.length, 10, 'five completed pairs required');
for (const arm of ['base', 'final']) {
  const selected = rows.filter(r => r.arm === arm); assert.equal(selected.length, 5);
  console.log(`ALLOCATOR_EVIDENCE policy=${selected[0].policy} arm=${arm} n=5 peakCommittedMiB=${median(selected.map(r=>r.peakCommittedMiB)).toFixed(2)} exitCommittedMiB=${median(selected.map(r=>r.exitCommittedMiB)).toFixed(2)} effective=${selected[0].effective || 'default; verbose disabled'}`);
}
fs.writeFileSync(path.join(root, 'allocator-evidence.json'), JSON.stringify(rows, null, 2) + '\n');
