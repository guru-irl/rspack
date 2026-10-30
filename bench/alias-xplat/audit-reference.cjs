const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const wanted = {
  nested: ['existing-new', 'deep-new', 'plugin-new', 'plugin-edit', 'alias-edit', 'outer-remove', 'unused-quiet', 'kept-edit', 'alias-unlink', 'real-new-after-unlink'],
  'recursive-alias': ['real-f-edit', 'alias-g-edit', 'alias-new']
};
const outputs = {
  'alias-edit': [['./a/b/c/race.js', 2], ['./existing/new.js', 1], ['./link/sub/a.js', 2], ['./real/sub/a.js', 2]],
  'real-new-after-unlink': [['./a/b/c/race.js', 2], ['./existing/new.js', 1], ['./real/sub/a.js', 2], ['./real/sub/b.js', 3]]
};
function validate(rows, arm) {
  const identities = rows.filter(row => row.type === 'identity');
  assert.equal(identities.length, 1, 'Missing or duplicate identity');
  const identity = identities[0];
  assert.equal(identity.arm, arm);
  assert.match(identity.sha256, /^[0-9a-f]{64}$/);
  assert.equal(identity.watchpack, '2.6.3');
  if (identity.platform === 'linux') assert.equal(identity.mapped, true);
  for (const row of rows) {
    assert.equal(row.arm, arm);
    assert.equal(row.platform, identity.platform);
    assert.equal(row.sha256, identity.sha256, 'Wrong binding hash');
    assert.equal(row.binding, identity.binding);
    assert.notEqual(row.type, 'failure');
  }
  assert.equal(rows.length, 16, 'Missing or extra receipt');
  for (const [scenario, ids] of Object.entries(wanted)) {
    assert.equal(rows.filter(row => row.type === 'closed' && row.scenario === scenario).length, 1);
    const steps = rows.filter(row => row.type === 'step' && row.scenario === scenario);
    assert.deepEqual(steps.map(row => row.id), ids, 'Missing, duplicate or reordered step');
    for (const row of steps) {
      assert.equal(typeof row.delivered, 'boolean');
      assert.equal(row.delivered, row.events.length > 0, 'Rebuild receipt disagrees with delivery flag');
      for (const event of row.events) {
        assert(!event.error);
        assert(Array.isArray(event.modifiedFiles));
        assert(Array.isArray(event.removedFiles));
      }
      if (outputs[row.id]) {
        assert.deepEqual(row.expectedOutput, outputs[row.id]);
        assert.equal(row.outputMatches, JSON.stringify(row.output) === JSON.stringify(outputs[row.id]), 'Dishonest output flag');
      }
    }
  }
  return rows.filter(row => row.type === 'step');
}
function parity(actual, reference) {
  const failures = [];
  for (let i = 0; i < reference.length; i++) {
    const a = actual[i], r = reference[i];
    if (r.delivered !== a.delivered) failures.push(`${a.scenario}/${a.id}: delivery ${a.delivered} != ${r.delivered}`);
    if (r.outputMatches && !a.outputMatches) failures.push(`${a.scenario}/${a.id}: stale output`);
    if (r.delivered && a.scenario === 'recursive-alias') {
      const files = new Set(a.events.flatMap(event => event.modifiedFiles));
      for (const file of new Set(r.events.flatMap(event => event.modifiedFiles))) {
        if (!files.has(file)) failures.push(`${a.scenario}/${a.id}: missing ${file}`);
      }
    }
  }
  return failures;
}
function read(file) { return fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse); }
const dir = process.argv[2];
const control = process.argv.includes('--controls');
const requireArm = process.argv.find(arg => arg.startsWith('--require-parity='))?.split('=')[1];
const wpRows = read(path.join(dir, 'wp.jsonl'));
const reference = validate(wpRows, 'wp');
if (control) {
  const mutations = [
    rows => rows.splice(3, 1),
    rows => { rows[2].sha256 = '0'.repeat(64); },
    rows => { rows.find(row => row.id === 'alias-edit').output[2][1] = 999; },
    rows => { rows.find(row => row.id === 'alias-g-edit').delivered = false; }
  ];
  for (const mutate of mutations) {
    const rows = structuredClone(wpRows);
    mutate(rows);
    assert.throws(() => validate(rows, 'wp'));
  }
  const rows = structuredClone(reference);
  rows.find(row => row.id === 'alias-g-edit').events[0].modifiedFiles = ['zr/link'];
  assert(parity(rows, reference).length > 0, 'Changed-file omission control was accepted');
  console.log('CONTROLS=5 rejected');
}
for (const arm of ['head', 'main', 'fixed']) {
  if (!fs.existsSync(path.join(dir, arm + '.jsonl'))) {
    if (requireArm === arm) throw Error(`Missing ${arm}`);
    continue;
  }
  const rows = read(path.join(dir, arm + '.jsonl'));
  const actual = validate(rows, arm);
  const failures = parity(actual, reference);
  console.log(JSON.stringify({ platform: wpRows[0].platform, arm, parity: failures.length === 0, failures }));
  if (requireArm === arm) assert.deepEqual(failures, [], `${arm} differs from Watchpack`);
}
