'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const {setTimeout: delay} = require('node:timers/promises');
const {snapshot} = require('./windows-memory-process.cjs');
module.exports = async function ({fixture, arm, rep, rspack, sources, NativeWatcher}) {
  let manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json')));
  let files = manifest.files, contexts = manifest.contexts;
  const fileCount = Number(process.env.M2_FILES), folderCount = Number(process.env.M2_FOLDERS);
  const applications = Number(process.env.M2_APPLICATIONS);
  assert.equal(files.length, fileCount);
  assert.equal(contexts.length, folderCount);
  assert([1, 4, 5, 20].includes(applications));
  const entry = path.join(fixture, 'index.js'), target = files[0], probe = path.join(fixture, 'memory-probe.txt');
  const past = new Date(Date.now() - 60000);
  for (const [file, text] of [[entry, 'module.exports = 1;'], [target, 'original'], [probe, 'initial-probe']]) {
    fs.writeFileSync(file, text);
    fs.utimesSync(file, past, past);
  }
  let native, generation = 0, builds = 0, readBuild = 0, failure, enabled = false, active;
  let probeGeneration = 0;
  const writes = [], emitted = [], watches = [], snapshots = [snapshot('before-watch')];
  const orig = NativeWatcher.prototype.watch;
  NativeWatcher.prototype.watch = function (...args) {
    native = this;
    const currentGeneration = ++generation;
    args[0][0] = [...new Set([...args[0][0], ...files, probe])];
    args[1][0] = [...new Set([...args[1][0], ...contexts])];
    // The readiness probe is a harness registration, not a compilation dependency.
    args[0][1] = args[0][1].filter(file => file !== probe);
    assert(args[0][0].length >= fileCount && args[1][0].length >= folderCount);
    const record = {generation: currentGeneration, files: args[0][0].length, contexts: args[1][0].length, missing: args[2][0].length};
    watches.push(record);
    const callback = args[4], undelayed = args[5];
    args[4] = (error, result) => {
      if (error) failure = error;
      if (result?.changedFiles.includes(probe)) {
        probeGeneration = currentGeneration;
        result = {changedFiles: result.changedFiles.filter(file => file !== probe), removedFiles: result.removedFiles};
        if (!error && !result.changedFiles.length && !result.removedFiles.length) return;
      }
      if (active && result?.changedFiles.includes(target) && active.receiptAt === undefined) {
        active.receiptAt = performance.now();
        active.callbackGeneration = currentGeneration;
        active.current = currentGeneration === generation;
      }
      return callback(error, result);
    };
    args[5] = event => { if (event.path !== probe) return undelayed(event); };
    const start = performance.now();
    const result = orig.apply(this, args);
    record.dispatchMs = performance.now() - start;
    return result;
  };
  const output = path.join(fixture, 'output', `${arm}-${rep}`);
  let compiler = rspack({context: fixture, mode: 'development', devtool: false, target: 'node', entry: './index.js', output: {path: output}, experiments: {nativeWatcher: true}, plugins: [c => {
    c.hooks.watchRun.tap('MemoryMeasurements', () => {
      if (active && active.watchRunAt === undefined && c.modifiedFiles?.has(target)) active.watchRunAt = performance.now();
    });
    c.hooks.thisCompilation.tap('MemoryMeasurements', compilation => {
      readBuild++;
      for (const file of files) compilation.fileDependencies.add(file);
      for (const dir of contexts) compilation.contextDependencies.add(dir);
      compilation.fileDependencies.add(path.join(fixture, `ready-${readBuild}.txt`));
      const value = fs.readFileSync(target, 'utf8');
      emitted.push(value);
      compilation.emitAsset('snapshot.txt', new sources.RawSource(value));
    });
    c.hooks.done.tap('MemoryMeasurements', () => {
      if (enabled && readBuild >= 2 && readBuild < applications) {
        assert(!active || active.receiptAt !== undefined && active.watchRunAt !== undefined);
        const value = `value-${readBuild - 1}`;
        active = {build: readBuild, value, savedAt: performance.now()};
        writes.push(active);
        fs.writeFileSync(target, value);
      }
    });
  }]});
  let watching = compiler.watch({aggregateTimeout: 50}, (error, stats) => {
    failure = error || (stats?.hasErrors() ? new Error(stats.toString()) : failure);
    builds++;
  });
  async function until(predicate, label) {
    const end = Date.now() + 300000;
    while (!predicate() && Date.now() < end) {
      if (failure) throw failure;
      await delay(50);
    }
    if (failure) throw failure;
    assert(predicate(), label);
  }
  // collectTimeInfoEntries alone is not an applied barrier: initial file mtimes
  // are recorded before analyze/watch/scan. A current aggregate callback proves
  // wait_for_event completed. Suppress only the probe's compiler callbacks.
  async function applied(count) {
    await until(() => builds >= count && generation >= count && native, 'build and native dispatch');
    let lastPoll = 0;
    await until(() => {
      if (performance.now() - lastPoll < 250) return false;
      lastPoll = performance.now();
      const known = new Set(native.collectTimeInfoEntries().fileTimestamps.entries.map(row => row.path));
      return known.has(path.join(fixture, `ready-${count}.txt`)) && known.has(probe) && files.every(file => known.has(file));
    }, 'all registration time records');
    fs.writeFileSync(probe, `probe-${count}-${performance.now()}`);
    await until(() => probeGeneration === count, 'aggregate callback from the fully applied current generation');
    assert.equal(generation, count, 'probe must not cause another compilation');
  }
  async function quiet(phase, milliseconds = 1000) {
    await delay(milliseconds);
    if (failure) throw failure;
    global.gc();
    await delay(200);
    snapshots.push(snapshot(phase));
  }
  let closed = false;
  try {
    await applied(1);
    await quiet('initial-applied');
    if (applications > 1) {
      enabled = true;
      fs.writeFileSync(entry, 'module.exports = 2;');
      await applied(applications);
    }
    assert.equal(builds, applications);
    assert.equal(generation, applications);
    assert.equal(writes.length, Math.max(0, applications - 2));
    const expected = ['original'];
    if (applications > 1) expected.push('original');
    for (let i = 1; i <= applications - 2; i++) expected.push(`value-${i}`);
    assert.deepEqual(emitted, expected);
    assert.equal(fs.readFileSync(path.join(output, 'snapshot.txt'), 'utf8'), expected.at(-1));
    for (const row of writes) assert(row.receiptAt >= row.savedAt && row.watchRunAt >= row.receiptAt && row.current);
    await quiet('steady');
    await quiet('steady-idle-10s', 10000);
    await new Promise((ok, no) => watching.close(error => error ? no(error) : ok()));
    await new Promise((ok, no) => compiler.close(error => error ? no(error) : ok()));
    await native.close();
    closed = true;
    await quiet('closed-references-held');
    const nativeWeak = new WeakRef(native), compilerWeak = new WeakRef(compiler), watchingWeak = new WeakRef(watching);
    NativeWatcher.prototype.watch = orig;
    native = compiler = watching = null;
    manifest = files = contexts = null;
    await quiet('dropped');
    await quiet('dropped-idle-10s', 10000);
    const collected = {native: nativeWeak.deref() === undefined, compiler: compilerWeak.deref() === undefined, watching: watchingWeak.deref() === undefined};
    const steady = snapshots.find(row => row.phase === 'steady');
    return {files: fileCount, contexts: folderCount, applications, outputParity: true, steadyMiB: steady.workingSetBytes / 2**20, steadyPrivateMiB: steady.privateBytes / 2**20, steadyHandles: steady.handles, snapshots, collected, watches, writes, unchangedRegistrationsResent: true, readiness: 'current-generation aggregate probe; no extra watch applications'};
  } finally {
    NativeWatcher.prototype.watch = orig;
    if (!closed) {
      if (watching) await new Promise((ok, no) => watching.close(error => error ? no(error) : ok()));
      if (compiler) await new Promise((ok, no) => compiler.close(error => error ? no(error) : ok()));
    }
  }
};
