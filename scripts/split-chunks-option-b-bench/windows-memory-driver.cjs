'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
assert(Date.now() < Date.parse('2026-10-29T02:50:00Z'), 'do not start a process near the hard stop');
assert.equal(process.platform, 'win32');
assert.equal(typeof global.gc, 'function');
const root = path.resolve('.bench-pr66-merge-costs'), [arm, repText] = process.argv.slice(2), rep = Number(repText);
const refs = {base: '2810c7fc89a82850f7bb29388c961fd5c77534f6', final: '3065e7ac0a3f1f9c48b61ce644cab1b588ebdfba'};
assert(arm in refs);
assert(rep >= 1 && rep <= 5);
const artifact = path.join(root, 'bindings', `optb-binding-Windows-${arm}`);
assert.equal(fs.readFileSync(path.join(artifact, 'commit.sha'), 'utf8').trim(), refs[arm]);
const addon = fs.realpathSync(path.join(artifact, 'binding.node'));
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon;
const req = createRequire(path.join(artifact, 'core/package.json'));
const {rspack, sources} = req('./dist/index.js'), {NativeWatcher} = req('@rspack/binding');
const pins = require('./expected-merge-bindings.json');
const identity = {source: refs[arm], ...require('./loaded-binding-identity.cjs').read(addon, pins.Windows[arm])};
console.log(JSON.stringify({kind: 'binding-identity', arm, rep, ...identity}));
const output = path.join(root, 'results', `${arm}-memory-${rep}.json`);
assert(!fs.existsSync(output), 'never overwrite a sample');
const watchdog = setTimeout(() => { console.error('FAILED: process exceeded 12 minute watchdog'); process.exit(1); }, 720000);
(async () => {
 try {
  const metrics = await require('./windows-memory-workload.cjs')({fixture: path.join(root, 'resend'), arm, rep, rspack, sources, NativeWatcher});
  assert(metrics.outputParity && metrics.steadyPrivateMiB > 0);
  const result = {arm, rep, platform: 'Windows', arch: process.arch, identity, mimallocShowStats: process.env.MIMALLOC_SHOW_STATS, allocatorPolicy: process.env.MEMORY_ALLOCATOR_POLICY || 'default', mimallocPurgeDelay: process.env.MIMALLOC_PURGE_DELAY || 'default', ...metrics};
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({kind: 'completed-sample', arm, rep, files: metrics.files, contexts: metrics.contexts, applications: metrics.applications, steadyPrivateMiB: metrics.steadyPrivateMiB, steadyMiB: metrics.steadyMiB, steadyHandles: metrics.steadyHandles, collected: metrics.collected}));
 } finally { clearTimeout(watchdog); }
})().catch(error => { console.error(error); process.exitCode = 1; });
