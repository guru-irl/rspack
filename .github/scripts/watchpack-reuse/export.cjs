const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result = path.resolve('bench-data/results');
const read = arm => JSON.parse(fs.readFileSync(path.join(result, 'timing', arm, 'timing.json')));
const off = read('OFF');
const on = read('ON');
function compare(a, b) { assert.deepEqual(a, b); }
const control = [[{ file: 'main.cjs', bytes: 1, sha256: 'a' }]];
compare(control, structuredClone(control));
for (const field of ['file', 'bytes', 'sha256']) {
  const bad = structuredClone(control);
  bad[0][0][field] = field === 'bytes' ? 2 : 'different';
  assert.throws(() => compare(control, bad));
}
assert.throws(() => compare(control, []));
compare(off.manifests, on.manifests);
assert.equal(off.callbacks, 6);
assert.equal(on.callbacks, 6);
assert.equal(off.edits, 5);
assert.equal(on.edits, 5);
assert.equal(off.coreEntrySha, on.coreEntrySha);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = Object.fromEntries([['OFF', off], ['ON', on]].map(([arm, data]) => {
  const samples = data.rearms.slice(1).map(row => row.milliseconds);
  return [arm, { samplesMs: samples, medianMs: median(samples), minimumMs: Math.min(...samples), maximumMs: Math.max(...samples), editToCallbackMedianMs: median(data.builds.slice(1).map(row => row.editToCallbackMs)), peakRss: data.peakRss, steadyRss: data.steadyRss }];
}));
fs.writeFileSync(path.join(result, 'timing-summary.json'), JSON.stringify(summary, null, 2) + '\n');
const delivery = path.resolve('bench-data/delivery');
fs.mkdirSync(delivery, { recursive: true });
const packages = ['rspack-core-2.2.9.tgz', 'rspack-binding-2.2.9.tgz', 'rspack-binding-linux-x64-gnu-2.2.9.tgz', 'rspack.linux-x64-gnu.node'];
for (const file of packages) fs.copyFileSync(path.join('bench-data/pack', file), path.join(delivery, file));
const nativeSha = hash(path.join(delivery, 'rspack.linux-x64-gnu.node'));
assert.equal(nativeSha, 'c9ce103a4bf4f6068cb41021aac46a115153ab299f4236db2f36a073788f77da');
const source = fs.readFileSync(path.join(result, 'source.sha'), 'utf8').trim();
const run = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
fs.writeFileSync(path.join(delivery, 'README.md'), `# Replay pack with opt-in Watchpack reuse

Source commit: ${source}
Build and validation: ${run}
Node 22.23.3, pnpm 11.26.0, GitHub ubuntu-22.04. Only JavaScript artifacts were built. No native rebuild was performed.

## Flags

- RSPACK_SPLIT_CHUNKS_REPLAY=1 enables SplitChunks replay from the base replay pack.
- RSPACK_WATCHPACK_REUSE=1 enables Watchpack instance reuse. Set it before constructing the compiler. Both flags can be used together.
- With RSPACK_WATCHPACK_REUSE unset, watcher behavior equals the replay pack. The core archive is different, but the default watcher still creates and closes an instance on every cycle.

## Reuse semantics

Reuse requires the same watch options object. Each cycle removes the previous one-shot handlers and installs new ones. Forwarding listeners are installed once per instance. Re-arm diffs the watched dependencies in Watchpack. Changes recorded while paused are forwarded after re-arm and aggregated on a timer. getInfo takes ownership of pending sets while paused, so changes consumed by a manually started build do not replay. Closing forgets the instance and options identity. Re-watching creates a fresh instance.

## Package identity

Core entry dist/index.js SHA-256: ${off.coreEntrySha}
Native rspack.linux-x64-gnu.node SHA-256: ${nativeSha}
The wrapper, GNU binding archive, and bare native file are byte-identical to the replay pack from run 40169154141. Native selection was verified through /proc/self/maps in each Node process.

## Validation

All watch suites, the watch-related compiler and MultiCompiler cases, and the new cases were run twice per flag state. See the evidence artifact for exact results and the known release-profile loader failures. Removing the paused-change flush fails the held-build case. Removing getInfo ownership fails the manual-invalidate case. The real source was restored and rebuilt before packaging.

The public fixture was generated at a4ca7fd6ff8bc31a48de4ef91922fcb1af1e53dc. One development watch process per arm handled five content edits. Every edit rebuilt exactly once. All emitted filenames and bytes match between OFF and ON after the cold build and every edit.

| Flag | Re-arm median, ms | Range, ms | Edit-to-callback median, ms |
| --- | ---: | ---: | ---: |
${Object.entries(summary).map(([arm, row]) => `| ${arm} | ${row.medianMs.toFixed(3)} | ${row.minimumMs.toFixed(3)} to ${row.maximumMs.toFixed(3)} | ${row.editToCallbackMedianMs.toFixed(3)} |`).join('\n')}

These are five re-arms per process on one Linux runner, not a cross-platform performance claim. Memory samples are Linux-only. macOS and Windows were not measured. Reuse still scans the dependency lists and constructs Watchpack diff maps. It avoids recreating unchanged path watchers but does not remove that scan.

Verify this directory with sha256sum -c SHA256SUMS before use. Do not change the covered files.
`);
const covered = ['README.md', ...packages];
fs.writeFileSync(path.join(delivery, 'SHA256SUMS'), covered.map(file => `${hash(path.join(delivery, file))}  ${file}\n`).join(''));
console.log(JSON.stringify({ source, run, coreEntrySha: off.coreEntrySha, nativeSha, sha256sumsHash: hash(path.join(delivery, 'SHA256SUMS')), summary }, null, 2));
