const fs = require('node:fs');
const assert = require('node:assert/strict');
const [dir, arm] = process.argv.slice(2);
assert(['main', 'head'].includes(arm));
const rows = [];
for (let n = 1; n <= 10; n++) {
  const lines = fs.readFileSync(`${dir}/${arm}-${n}.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  const identity = lines.filter(r => r.type === 'identity');
  assert.equal(identity.length, 1);
  assert.equal(identity[0].arm, arm);
  assert.equal(identity[0].mapped, true);
  assert.equal(identity[0].watchpack, '2.6.3');
  assert.equal(lines.filter(r => r.type === 'failure').length, 0);
  assert.deepEqual(lines.filter(r => r.type === 'closed').map(r => r.scenario), ['recursive-alias']);
  const steps = lines.filter(r => r.type === 'step');
  assert.deepEqual(steps.map(r => `${r.scenario}/${r.id}`), ['recursive-alias/real-f-edit', 'recursive-alias/alias-g-edit', 'recursive-alias/alias-new']);
  for (const step of steps) for (const event of step.events) assert(!event.error, event.error);
  const first = steps[0];
  assert.equal(typeof first.probeMatches, 'boolean');
  assert.equal(first.bundleOutput, 1);
  const modified = [...new Set(first.events.flatMap(e => e.modifiedFiles))].sort();
  const removed = [...new Set(first.events.flatMap(e => e.removedFiles))].sort();
  rows.push({ n, delivered: first.delivered, modified, removed, probeOutput: first.probeOutput, probeMatches: first.probeMatches,
    aliasG: steps[1].delivered, aliasNew: steps[2].delivered, sha256: identity[0].sha256, sourceSha: identity[0].sourceSha, sourceTree: identity[0].sourceTree });
}
assert.equal(new Set(rows.map(r => r.sha256)).size, 1);
assert.equal(new Set(rows.map(r => r.sourceSha)).size, 1);
assert.equal(new Set(rows.map(r => r.sourceTree)).size, 1);
console.log(`RECURSIVE_IDENTITY ${arm} ${JSON.stringify({sha256: rows[0].sha256, sourceSha: rows[0].sourceSha, sourceTree: rows[0].sourceTree})}`);
for (const row of rows) console.log(`RECURSIVE_TRIAL ${arm} ${JSON.stringify(row)}`);
console.log(`RECURSIVE_COUNTS ${arm} ${JSON.stringify({
  trials: rows.length,
  delivered: rows.filter(r => r.delivered).length,
  listsRealFile: rows.filter(r => r.modified.includes('zr/real/f.txt')).length,
  listsLink: rows.filter(r => r.modified.includes('zr/link')).length,
  correctProbeOutput: rows.filter(r => r.probeMatches).length,
  correctBundleConstant: rows.length,
  aliasGDelivered: rows.filter(r => r.aliasG).length,
  aliasNewDelivered: rows.filter(r => r.aliasNew).length
})}`);
