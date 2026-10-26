const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  assert(sorted.length);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function equalOutputs(left, right) {
  assert(left && right);
  assert.equal(left.length, 6);
  assert.equal(right.length, 6);
  for (let i = 0; i < 6; i++) {
    assert(left[i].length && right[i].length);
    assert.deepEqual(left[i], right[i]);
  }
}
const control = Array.from({ length: 6 }, () => [{ file: 'one.js', bytes: 4, sha256: 'abcd' }]);
for (const kind of ['name', 'size', 'hash', 'missing', 'build']) {
  const bad = structuredClone(control);
  if (kind === 'name') bad[3][0].file = 'two.js';
  if (kind === 'size') bad[3][0].bytes = 5;
  if (kind === 'hash') bad[3][0].sha256 = 'abce';
  if (kind === 'missing') bad[3] = [];
  if (kind === 'build') bad.pop();
  assert.throws(() => equalOutputs(control, bad));
}
equalOutputs(control, structuredClone(control));
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'provenance.json'), 'utf8'));
const arms = Object.fromEntries(['MAIN', 'PR'].map(arm => [arm, [1, 2, 3].map(pair =>
  JSON.parse(fs.readFileSync(path.join(root, `pair-${pair}-${arm}`, 'timing.json'), 'utf8')))
]));
const reference = arms.MAIN[0].manifests;
for (const [arm, rows] of Object.entries(arms)) {
  for (const row of rows) {
    assert.equal(row.nativeIdentity.sha256, provenance.nativeSha256);
    assert.equal(row.callbacks, 6);
    assert.equal(row.edits, 5);
    assert.equal(row.rearms.length, 6);
    assert(row.rearms.slice(1).every(rearm => rearm.reused === (arm === 'PR')));
    assert.equal(new Set(row.rearms.map(rearm => `${rearm.files}/${rearm.directories}`)).size, 1);
    equalOutputs(reference, row.manifests);
  }
}
const summary = {};
for (const metric of ['watchMs', 'materializationMs', 'peakMiB', 'steadyMiB']) {
  const values = {};
  const processMedians = {};
  for (const [arm, rows] of Object.entries(arms)) {
    const samples = metric === 'watchMs' || metric === 'materializationMs'
      ? rows.map(row => row.rearms.slice(1).map(rearm => rearm[metric === 'watchMs' ? 'milliseconds' : 'materializationMs']))
      : rows.map(row => [row[metric === 'peakMiB' ? 'peakRss' : 'steadyRss'] / 1048576]);
    const all = samples.flat();
    processMedians[arm] = samples.map(median);
    values[arm] = { values: all, median: median(all), min: Math.min(...all), max: Math.max(...all) };
  }
  const gap = Math.abs(values.PR.median - values.MAIN.median);
  summary[metric] = {
    ...values, processMedians,
    delta: values.PR.median - values.MAIN.median,
    deltaPct: (values.PR.median / values.MAIN.median - 1) * 100,
    spreadExceedsGap: Object.values(processMedians).some(v => Math.max(...v) - Math.min(...v) > gap),
  };
}
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify({ provenance, metrics: summary, outputParity: true, comparatorControls: 'passed' }, null, 2));
console.log('Native identities and all output manifests match. Comparator controls passed.');
