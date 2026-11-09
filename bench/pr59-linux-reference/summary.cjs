const fs = require('node:fs');
const assert = require('node:assert/strict');
const dir = process.argv[2];
const arms = process.argv.slice(3);
const steps = [
  'nested/existing-new', 'nested/deep-new', 'nested/plugin-new', 'nested/plugin-edit',
  'nested/alias-edit', 'nested/outer-remove', 'nested/unused-quiet', 'nested/kept-edit',
  'nested/alias-unlink', 'nested/real-new-after-unlink', 'recursive-alias/real-f-edit',
  'recursive-alias/alias-g-edit', 'recursive-alias/alias-new'
];
const old = {
  main: [
    'No: none', 'Yes: ctx', 'No: none', 'No: none',
    'Yes: ctx, ctx/link/sub/a.js; stale output', 'Yes: none', 'No: none',
    'Yes: plugin, plugin/kept, plugin/kept/deep/file.txt', 'Yes: ctx',
    'No: none; stale output', 'Yes: zr/link', 'Yes: zr/link, zr/link/g.txt', 'Yes: zr/link'
  ],
  head: [
    'Yes: ctx', 'Yes: ctx', 'Yes: plugin', 'Yes: plugin',
    'Yes: ctx, ctx/link/sub/a.js, ctx/real/sub/a.js', 'Yes: none', 'No: none',
    'Yes: plugin/kept, plugin/kept/deep/file.txt', 'Yes: ctx', 'Yes: ctx',
    'Yes: zr/link, zr/real/f.txt', 'Yes: zr/link, zr/link/g.txt', 'Yes: zr/link'
  ],
  wp: [
    'Yes: ctx', 'Yes: ctx', 'Yes: plugin', 'Yes: plugin',
    'Yes: ctx, ctx/link/sub/a.js, ctx/real/sub/a.js', 'Yes: none', 'No: none',
    'Yes: plugin/kept, plugin/kept/deep/file.txt', 'Yes: ctx', 'Yes: ctx',
    'Yes: zr/link, zr/real/f.txt', 'Yes: zr/link, zr/link/g.txt', 'Yes: zr/link'
  ]
};
function normalize(row) {
  assert.equal(typeof row.delivered, 'boolean');
  assert(Array.isArray(row.events));
  for (const event of row.events) {
    assert(!event.error, event.error);
    assert(Array.isArray(event.modifiedFiles));
    assert(Array.isArray(event.removedFiles));
  }
  const files = kind => [...new Set(row.events.flatMap(event => event[kind]))].sort();
  return { delivered: row.delivered, modified: files('modifiedFiles'), removed: files('removedFiles'), stale: row.outputMatches === false };
}
function previousFormat(row) {
  return `${row.delivered ? 'Yes' : 'No'}: ${row.modified.length ? row.modified.join(', ') : 'none'}${row.stale ? '; stale output' : ''}`;
}
function detail(row) {
  const format = files => files.length ? files.map(f => '`' + f + '`').join(', ') : 'none';
  return `${row.delivered ? 'Yes' : 'No'}: modified ${format(row.modified)}; removed ${format(row.removed)}${row.stale ? '; stale output' : ''}`;
}
// Controls: a changed delivery, modified path, removed path, and stale output must all differ.
const control = { delivered: true, events: [{ modifiedFiles: ['a'], removedFiles: [] }], outputMatches: true };
const fingerprint = row => JSON.stringify(normalize(row));
for (const mutant of [
  { ...control, delivered: false },
  { ...control, events: [{ modifiedFiles: ['b'], removedFiles: [] }] },
  { ...control, events: [{ modifiedFiles: ['a'], removedFiles: ['x'] }] },
  { ...control, outputMatches: false }
]) assert.notEqual(fingerprint(mutant), fingerprint(control));
for (const arm of arms) {
  assert(old[arm], `Unknown arm ${arm}`);
  const trials = [1, 2, 3].map(n => {
    const lines = fs.readFileSync(`${dir}/${arm}-${n}.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
    const identities = lines.filter(r => r.type === 'identity');
    assert.equal(identities.length, 1);
    assert.equal(identities[0].arm, arm);
    assert.equal(identities[0].platform, 'linux');
    assert.equal(identities[0].mapped, true);
    assert.equal(identities[0].watchpack, '2.6.3');
    assert.equal(lines.filter(r => r.type === 'failure').length, 0);
    assert.deepEqual(lines.filter(r => r.type === 'closed').map(r => r.scenario), ['nested', 'recursive-alias']);
    const rows = lines.filter(r => r.type === 'step');
    assert.deepEqual(rows.map(r => `${r.scenario}/${r.id}`), steps);
    return { identity: identities[0], rows: rows.map(normalize) };
  });
  assert.equal(new Set(trials.map(t => t.identity.sha256)).size, 1, `${arm} binding changed`);
  assert.equal(new Set(trials.map(t => t.identity.sourceSha)).size, 1);
  assert.equal(new Set(trials.map(t => t.identity.sourceTree)).size, 1);
  console.log(`SUMMARY ${arm} IDENTITY ${JSON.stringify(trials[0].identity)}`);
  steps.forEach((step, i) => {
    const variants = [...new Set(trials.map(t => JSON.stringify(t.rows[i])))].map(JSON.parse);
    const previous = old[arm][i];
    const differs = variants.some(v => previousFormat(v) !== previous);
    console.log(`SUMMARY ${arm} ${step} ${variants.length > 1 ? 'UNSTABLE ' : ''}${variants.map(detail).join(' / ')} | old ${previous} | ${differs ? 'DIFF' : 'SAME'}`);
  });
}
