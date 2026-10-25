const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result = path.resolve('bench-data/results');
const read = arm => JSON.parse(fs.readFileSync(path.join(result, 'timing', arm, 'timing.json')));
const data = Object.fromEntries(['OFF', 'REUSE', 'SKIP'].map(arm => [arm, read(arm)]));
function compare(a, b) { assert.deepEqual(a, b); }
const control = [[{ file: 'main.cjs', bytes: 1, sha256: 'a' }]];
compare(control, structuredClone(control));
for (const field of ['file', 'bytes', 'sha256']) {
  const bad = structuredClone(control);
  bad[0][0][field] = field === 'bytes' ? 2 : 'different';
  assert.throws(() => compare(control, bad));
}
assert.throws(() => compare(control, []));
for (const row of Object.values(data)) {
  compare(data.OFF.manifests, row.manifests);
  assert.equal(row.callbacks, 6);
  assert.equal(row.edits, 5);
  assert.equal(row.coreEntrySha, data.OFF.coreEntrySha);
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = Object.fromEntries(Object.entries(data).map(([arm, row]) => {
  const samples = row.rearms.slice(1).map(item => item.milliseconds);
  const materialization = row.rearms.slice(1).map(item => item.materializationMs);
  return [arm, { samplesMs: samples, medianMs: median(samples), minimumMs: Math.min(...samples), maximumMs: Math.max(...samples), materializationSamplesMs: materialization, materializationMedianMs: median(materialization), editToCallbackMedianMs: median(row.builds.slice(1).map(item => item.editToCallbackMs)), peakRss: row.peakRss, steadyRss: row.steadyRss }];
}));
fs.writeFileSync(path.join(result, 'timing-summary.json'), JSON.stringify(summary, null, 2) + '\n');
const delivery = path.resolve('bench-data/delivery');
fs.mkdirSync(delivery, { recursive: true });
const packages = ['rspack-core-2.2.9.tgz', 'rspack-binding-2.2.9.tgz', 'rspack-binding-linux-x64-gnu-2.2.9.tgz', 'rspack.linux-x64-gnu.node'];
for (const file of packages) fs.copyFileSync(path.join('bench-data/pack', file), path.join(delivery, file));
const nativeSha = hash(path.join(delivery, 'rspack.linux-x64-gnu.node'));
assert.equal(nativeSha, 'c9ce103a4bf4f6068cb41021aac46a115153ab299f4236db2f36a073788f77da');
const coreEntrySha = hash(path.join(result, 'delivery-index.js'));
const source = fs.readFileSync(path.join(result, 'source.sha'), 'utf8').trim();
const run = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
fs.writeFileSync(path.join(delivery, 'README.md'), `# Replay pack with opt-in Watchpack reuse

Source commit: ${source}
Build and validation: ${run}
Node 22.23.3, pnpm 11.26.0, GitHub ubuntu-22.04. Only JavaScript artifacts were built. No native rebuild was performed.

## Flags

- RSPACK_SPLIT_CHUNKS_REPLAY=1 enables SplitChunks replay from the base replay pack.
- RSPACK_WATCHPACK_REUSE=1 enables Watchpack instance reuse and unchanged-set skipping. Set it before constructing the compiler. Both flags can be used together.

## Unset behavior

With RSPACK_WATCHPACK_REUSE unset, NodeWatchFileSystem has the same behavior and follows the replay core's fresh-instance watch path. Watching is unchanged and follows the same code path. The replay core dist/index.js SHA-256 is 6737ba7ca624fb2ca83b6698fd9a1f85ca7b510fa50b363294f62e9f32607c7a. This is the same behavior, not the same file. The new core bytes differ because its implementation changed.

The added work that still runs when unset is the constructor's environment-variable read and option/field initialization; creation and storage of the named infrastructure logger; per-call reuse and ownership flag checks; storage of the options identity and current one-shot handler references; and clearing that bookkeeping on close. The undelayed one-shot listener is prepended on a new instance, which has no earlier listeners. Its event order is unchanged. No dependency Set comparison or retention, reuse flush, or reuse DEBUG logging runs when unset. The ordinary new Watchpack, forwarding listeners, watch(), old-instance close, timestamp collection, purge, deprecated getters, and pending-set behavior remain the replay path. The two normal, unset validation passes are the evidence for this path.

## Reuse semantics

Reuse requires the same watch options object. Each cycle removes the previous one-shot handlers and installs new ones. Forwarding listeners are installed once per instance.

If files, directories, and missing are Sets and all three have the same sizes and members as the previous call, re-arm skips Watchpack's watch(). It sets paused=false and updates startTime. Watchpack's filtered missing-path set remains valid because the input members are unchanged. Changed sets, or any non-Set argument, fall back to Watchpack's reuse diff. This compares complete sets, not dependency deltas. The previous Set references are released on close.

Changes recorded while paused are forwarded after re-arm and aggregated on a timer. getInfo takes ownership of pending sets while paused, so changes consumed by a manually started build do not replay. Closing forgets the instance and options identity. Re-watching creates a fresh instance.

## DEBUG decisions

Every re-arm with reuse enabled records exactly one DEBUG decision under rspack.NodeWatchFileSystem:

- reuse: skipped (sets unchanged)
- reuse: diffed
- reuse: new instance

There is no reuse decision when the flag is off. To print the decisions, configure:

\`\`\`js
infrastructureLogging: { debug: [/rspack\\.NodeWatchFileSystem/] }
\`\`\`

To count them without changing console filtering, tap the hook:

\`\`\`js
compiler.hooks.infrastructureLog.tap('WatchDecisions', (name, type, args) => {
  if (name === 'rspack.NodeWatchFileSystem' && type === 'debug') {
    // Record args[0]. Return undefined to preserve the usual logger.
  }
});
\`\`\`

The infrastructureLog hook runs before console-level filtering. The compiler case checks the skipped and diffed decisions with the console level set to none.

## Package identity

Core entry dist/index.js SHA-256: ${coreEntrySha}
Native rspack.linux-x64-gnu.node SHA-256: ${nativeSha}
The wrapper, GNU binding archive, and bare native file are byte-identical to the replay pack from run 40169154141. Native selection was verified through /proc/self/maps in test and timing workers.

## Validation and timing

All watch suites, the watch-related compiler and MultiCompiler cases, and the new cases were run twice per flag state. See the evidence artifact for exact results and the known release-profile loader failures. Removing the paused-change flush fails the held-build case. Removing getInfo ownership fails the manual-invalidate case. The real source was restored and rebuilt before packaging.

The public fixture was generated at a4ca7fd6ff8bc31a48de4ef91922fcb1af1e53dc. One development watch process per arm handled five content edits, with RSPACK_SPLIT_CHUNKS_REPLAY=1 held constant. Every edit rebuilt exactly once. All emitted filenames and bytes match between all arms after the cold build and every edit. The REUSE arm uses the per-instance skipUnchanged=false control; SKIP uses the flag's default behavior.

| Measurement | Median, ms | Samples |
| --- | ---: | ---: |
| Watching's three dependency Set materializations, OFF | ${summary.OFF.materializationMedianMs.toFixed(3)} | 5 |
| watch() with reuse OFF | ${summary.OFF.medianMs.toFixed(3)} | 5 |
| watch() with reuse ON, skip disabled | ${summary.REUSE.medianMs.toFixed(3)} | 5 |
| watch() with reuse ON and skip | ${summary.SKIP.medianMs.toFixed(3)} | 5 |

Materialization medians in the REUSE and SKIP arms were ${summary.REUSE.materializationMedianMs.toFixed(3)} ms and ${summary.SKIP.materializationMedianMs.toFixed(3)} ms. The evidence includes every sample, CPU time, dependency counts, edit-to-callback latency, and Linux memory samples. A timing-only core build records the three Set construction durations in Watching. Those probes are absent from this delivery. The delivered core entry hash above is for the uninstrumented archive.

These are five edits per process on one Linux runner, not a cross-platform performance claim. macOS and Windows performance and memory were not measured. Set equality still scans the full dependency sets. Reuse without the skip also constructs Watchpack diff maps.

Verify this directory with sha256sum -c SHA256SUMS before use. Do not change the covered files.
`);
const covered = ['README.md', ...packages];
fs.writeFileSync(path.join(delivery, 'SHA256SUMS'), covered.map(file => `${hash(path.join(delivery, file))}  ${file}\n`).join(''));
console.log(JSON.stringify({ source, run, coreEntrySha, timingEntrySha: data.OFF.coreEntrySha, nativeSha, sha256sumsHash: hash(path.join(delivery, 'SHA256SUMS')), summary }, null, 2));
