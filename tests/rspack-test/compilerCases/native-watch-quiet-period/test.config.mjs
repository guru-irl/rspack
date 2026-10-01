import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { rspack } from "@rspack/core";

const require = createRequire(import.meta.url);
const aggregateTimeout = 200;
const windows = process.platform === "win32";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/** @param {string} file @returns {number} */
function readExecutedBundleValue(file) {
  delete require.cache[require.resolve(file)];
  return require(file).default;
}

async function runCase() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rspack-watch-")));
  const valueFile = path.join(root, "value.js");
  const output = path.join(root, "dist");
  const outputFile = path.join(output, "main.js");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "commonjs" }));
  fs.writeFileSync(path.join(root, "entry.js"), "exports.default = require('./value.js');");
  fs.writeFileSync(valueFile, "module.exports = 0;");
  const old = new Date(Date.now() - 10000);
  for (const file of ["package.json", "entry.js", "value.js"]) {
    fs.utimesSync(path.join(root, file), old, old);
  }

  const abort = new AbortController();
  const { signal } = abort;
  const runs = [];
  const writeTimes = [];
  const eventTimes = [];
  const acknowledgement = deferred();
  const waiters = new Set();
  let done = 0;
  let registrations = 0;
  let failure;
  const pulse = () => {
    for (const waiter of waiters) waiter();
  };
  const waitFor = predicate => new Promise((resolve, reject) => {
    const check = () => {
      if (failure) { waiters.delete(check); reject(failure); }
      else if (predicate()) { waiters.delete(check); resolve(); }
    };
    waiters.add(check);
    check();
  });
  const diagnostics = () => JSON.stringify({
    writeTimes,
    writeGaps: writeTimes.slice(1).map((time, i) => time - writeTimes[i]),
    filteringTimes: eventTimes,
    filteringGaps: eventTimes.slice(1).map((time, i) => time - eventTimes[i]),
    runs: runs.map(run => ({ ...run, changed: [...run.changed], removed: [...run.removed] })),
    done,
    registrations,
  });
  const compiler = rspack({
    context: root,
    mode: "development",
    target: "node",
    devtool: false,
    entry: "./entry.js",
    output: { path: output, filename: "main.js", library: { type: "commonjs2" } },
    experiments: { nativeWatcher: true },
    watchOptions: {
      aggregateTimeout,
      ignored: file => {
        if (file === valueFile && writeTimes.length > 0) {
          eventTimes.push(performance.now());
          acknowledgement.resolve();
        }
        return file === output || file.startsWith(`${output}${path.sep}`);
      },
    },
    plugins: [c => {
      c.hooks.watchRun.tap("QuietPeriod", () => {
        runs.push({ startedAt: performance.now(), changed: new Set(c.modifiedFiles), removed: new Set(c.removedFiles) });
        pulse();
      });
      c.hooks.afterDone.tap("QuietPeriod", () => {
        done++;
        pulse();
      });
    }],
  });
  // Observe the real nextTick watch registration without replacing callbacks.
  const wfs = compiler.watchFileSystem;
  const watch = wfs.watch;
  wfs.watch = function (...args) {
    const handle = watch.apply(this, args);
    registrations++;
    pulse();
    return handle;
  };

  let watchdog;
  let succeeded = false;
  try {
    await Promise.race([
      new Promise((_, reject) => {
        watchdog = globalThis.setTimeout(() => reject(new Error(`native watcher quiet-period watchdog expired: ${diagnostics()}`)), process.env.CI ? 15000 : 12000);
      }),
      (async () => {
        compiler.watch(compiler.options.watchOptions, (error, stats) => {
          if (error || stats?.hasErrors()) {
            failure = error || new Error(stats.toString());
            pulse();
          }
        });
        await waitFor(() => done >= 1 && registrations >= 1);
        await setImmediate(undefined, { signal });
        await setTimeout(windows ? 500 : 250, undefined, { signal });
        const start = performance.now();
        for (let value = 1; value <= 5; value++) {
          const remaining = start + (value - 1) * 100 - performance.now();
          if (remaining > 0) await setTimeout(remaining, undefined, { signal });
          signal.throwIfAborted();
          writeTimes.push(performance.now());
          fs.writeFileSync(valueFile, `module.exports = ${value};`);
        }
        await acknowledgement.promise;
        signal.throwIfAborted();
        await waitFor(() => done >= 2 && registrations >= 2);
        await setImmediate(undefined, { signal });
        await setTimeout(windows ? 1500 : 1000, undefined, { signal });

        const filesystemRuns = runs.slice(1);
        const value = readExecutedBundleValue(outputFile);
        const context = `${diagnostics()}, finalValue=${value}`;
        for (let i = 1; i < writeTimes.length; i++) {
          expect(writeTimes[i] - writeTimes[i - 1], `write gap broke the quiet-period precondition: ${context}`).toBeLessThan(aggregateTimeout);
        }
        expect(filesystemRuns, `five writes must form exactly one rebuild: ${context}`).toHaveLength(1);
        expect(filesystemRuns[0].changed.has(valueFile), `rebuild must include the edited source: ${context}`).toBe(true);
        expect(value, `bundle must include the fifth write: ${context}`).toBe(5);
      })(),
    ]);
    succeeded = true;
  } finally {
    globalThis.clearTimeout(watchdog);
    failure ??= new Error("native watcher: stopped");
    abort.abort(failure);
    acknowledgement.resolve();
    pulse();
    let cleanupError;
    try {
      await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
    } catch (error) {
      cleanupError = error;
    } finally {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (succeeded && cleanupError) throw cleanupError;
  }
}

/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
  description: "should restart native aggregation until the last write is quiet",
  async run() {
    await runCase();
  },
};
