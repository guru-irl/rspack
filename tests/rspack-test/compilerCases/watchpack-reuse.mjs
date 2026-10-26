import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for watch state");
    await delay(10);
  }
};
const close = watching => new Promise((resolve, reject) => watching.close(error => error ? reject(error) : resolve()));

function watchCase(name, description, run, prepare) {
  let root;
  let entry;
  let dep;
  return {
    name,
    description,
    options() {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rspack-watchpack-reuse-")));
      entry = path.join(root, "entry.js");
      dep = path.join(root, "dep.js");
      fs.writeFileSync(entry, "module.exports = 1;\n");
      fs.writeFileSync(dep, "module.exports = 2;\n");
      // Initial fixture creation is not an edit during watch mode.
      const beforeWatch = new Date(Date.now() - 10000);
      fs.utimesSync(entry, beforeWatch, beforeWatch);
      fs.utimesSync(dep, beforeWatch, beforeWatch);
      return { entry, experiments: { nativeWatcher: false }, infrastructureLogging: { level: "none", debug: false } };
    },
    async build(context, compiler) {
      const builds = [];
      let failure;
      let watching;
      const start = () => {
        watching = compiler.watch({ aggregateTimeout: 30 }, (error, stats) => {
          if (error) failure = error;
          else builds.push(stats);
        });
        return watching;
      };
      const wait = async count => {
        await until(() => failure || builds.length >= count);
        if (failure) throw failure;
        await new Promise(resolve => setImmediate(resolve));
      };
      const quiet = async count => {
        await delay(250);
        if (failure) throw failure;
        expect(builds).toHaveLength(count);
      };
      try {
        prepare?.({ compiler, root, entry, dep });
        start();
        await wait(1);
        expect(builds[0].hasErrors()).toBe(false);
        await run({ compiler, entry, dep, wait, quiet, get watching() { return watching; } });
      } finally {
        if (watching) await close(watching);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  };
}

export default [
  watchCase("same-options", "should reuse the same options and replace cycle handlers", async ({ compiler, entry, wait, quiet }) => {
    const first = compiler.watchFileSystem.watcher;
    const watch = compiler.watchFileSystem.watch.bind(compiler.watchFileSystem);
    compiler.watchFileSystem.watch = (...args) => {
      const handle = watch(...args);
      compiler.watchFileSystem.watcher.on("change", () => {});
      compiler.watchFileSystem.watcher.on("remove", () => {});
      return handle;
    };
    for (let cycle = 1; cycle <= 12; cycle++) {
      fs.writeFileSync(entry, `module.exports = ${cycle + 2};\n`);
      await wait(cycle + 1);
      expect(compiler.watchFileSystem.watcher).toBe(first);
      expect(first.listenerCount("change")).toBeLessThanOrEqual(3);
      expect(first.listenerCount("remove")).toBeLessThanOrEqual(2);
      expect(first.listenerCount("aggregated")).toBe(2);
    }
    await quiet(13);
  }),
  watchCase("unchanged-dependencies", "should skip unchanged sets and watch new imports after skipped re-arms", async ({ compiler, entry, dep, wait, quiet }) => {
    const watcher = compiler.watchFileSystem.watcher;
    const watch = watcher.watch;
    let calls = 0;
    watcher.watch = function(...args) {
      calls++;
      return watch.apply(this, args);
    };
    fs.writeFileSync(entry, "module.exports = 10;\n");
    await wait(2);
    expect(calls).toBe(0);
    fs.writeFileSync(entry, "module.exports = 11;\n");
    await wait(3);
    await quiet(3);
    expect(calls).toBe(0);
    fs.writeFileSync(entry, 'module.exports = require("./dep.js");\n');
    await wait(4);
    expect(calls).toBe(1);
    fs.writeFileSync(dep, "module.exports = 12;\n");
    await wait(5);
    await quiet(5);
    expect(calls).toBe(1);
    fs.writeFileSync(entry, "module.exports = 7;\n");
    await wait(6);
    expect(compiler.watchFileSystem.watcher.fileWatchers.has(dep)).toBe(false);
    fs.writeFileSync(dep, "module.exports = 8;\n");
    await quiet(6);
  }),
  watchCase("reentrant-invalidate", "should include a paused change when an invalid tap invalidates again", async ({ compiler, entry, watching, wait, quiet }) => {
    let release;
    let held = false;
    let reenter = false;
    const modified = [];
    compiler.hooks.watchRun.tap("WatchpackReentrantTest", () => modified.push(new Set(compiler.modifiedFiles)));
    compiler.hooks.invalid.tap("WatchpackReentrantTest", () => {
      if (reenter) {
        reenter = false;
        watching.invalidate();
      }
    });
    compiler.hooks.make.tapPromise("WatchpackReentrantTest", async () => {
      if (held) return;
      held = true;
      await new Promise(resolve => { release = resolve; });
    });
    watching.invalidate();
    await until(() => release);
    try {
      fs.writeFileSync(entry, "module.exports = 20;\n");
      await until(() => compiler.watchFileSystem.watcher.aggregatedChanges.has(entry));
      reenter = true;
    } finally {
      release();
    }
    await wait(3);
    await quiet(3);
    expect(modified[1].has(entry)).toBe(true);
  }),
  watchCase("synthetic-paused", "should not replay a synthetic file-watcher event during a held build", async ({ compiler, entry, watching, wait, quiet }) => {
    let release;
    let held = false;
    compiler.hooks.make.tapPromise("WatchpackSyntheticTest", async () => {
      if (held) return;
      held = true;
      await new Promise(resolve => { release = resolve; });
    });
    watching.invalidate();
    await until(() => release);
    try {
      const watcher = compiler.watchFileSystem.watcher;
      watcher.fileWatchers.get(entry).watcher.emit("change", Date.now(), "change");
      expect(watcher.aggregatedChanges.has(entry)).toBe(true);
    } finally {
      release();
    }
    await wait(2);
    await quiet(2);
  }),
  watchCase("nested-directory", "should not replay a nested non-imported write during a held build", async ({ compiler, entry, watching, wait, quiet }) => {
    const root = path.dirname(entry);
    const sub = path.join(root, "sub");
    await until(() => {
      const directory = compiler.watchFileSystem.watcher.directoryWatchers.get(root)?.watcher.directoryWatcher;
      const nested = directory?.directories.get(sub);
      return nested && typeof nested === "object" && !nested.directoryWatcher.initialScan;
    });
    let release;
    let held = false;
    compiler.hooks.make.tapPromise("WatchpackNestedDirectoryTest", async () => {
      if (held) return;
      held = true;
      await new Promise(resolve => { release = resolve; });
    });
    watching.invalidate();
    await until(() => release);
    try {
      fs.writeFileSync(path.join(sub, "not-imported.txt"), "generated during the build\n");
      await until(() => compiler.watchFileSystem.watcher.aggregatedChanges.has(root));
    } finally {
      release();
    }
    await wait(2);
    await quiet(2);
  }, ({ compiler, root }) => {
    fs.mkdirSync(path.join(root, "sub"));
    compiler.hooks.afterCompile.tap("WatchpackNestedDirectoryTest", compilation => {
      compilation.contextDependencies.add(root);
    });
  }),
  watchCase("missing-directory", "should rebuild when a missing dependency becomes a directory during a held build", async ({ compiler, entry, watching, wait, quiet }) => {
    const later = path.join(path.dirname(entry), "later");
    let release;
    let held = false;
    compiler.hooks.make.tapPromise("WatchpackMissingDirectoryTest", async () => {
      if (held) return;
      held = true;
      await new Promise(resolve => { release = resolve; });
    });
    watching.invalidate();
    await until(() => release);
    try {
      fs.mkdirSync(later);
      fs.writeFileSync(path.join(later, "index.js"), "module.exports = 21;\n");
      await until(() => compiler.watchFileSystem.watcher.aggregatedChanges.has(later));
    } finally {
      release();
    }
    await wait(3);
    await quiet(3);
  }, ({ compiler, root }) => {
    compiler.hooks.afterCompile.tap("WatchpackMissingDirectoryTest", compilation => {
      compilation.missingDependencies.add(path.join(root, "later"));
    });
  }),
  watchCase("manual-invalidate", "should consume paused changes on manual invalidate without replay", async ({ compiler, entry, watching, wait, quiet }) => {
    const watcher = compiler.watchFileSystem.watcher;
    let transferred;
    const consume = Object.getOwnPropertySymbols(watching.watcher).find(symbol => symbol.description === "consumeWatcherInfo") ?? "getInfo";
    const getInfo = watching.watcher[consume];
    watching.watcher[consume] = () => {
      transferred = getInfo();
      return transferred;
    };
    watcher.pause();
    fs.writeFileSync(entry, "module.exports = 5;\n");
    await until(() => watcher.aggregatedChanges.has(entry));
    const observed = watching.watcher.getInfo();
    expect(observed.changes.has(entry)).toBe(true);
    expect(watcher.aggregatedChanges.has(entry)).toBe(true);
    watching.invalidate();
    expect(transferred.changes.has(entry)).toBe(true);
    const later = path.join(path.dirname(entry), "later-event.js");
    expect(compiler.watchFileSystem.emit("change", later, Date.now())).toBe(true);
    expect(transferred.changes.has(later)).toBe(false);
    await wait(2);
    expect(compiler.modifiedFiles.has(entry)).toBe(true);
    await quiet(2);
  }),
  {
    name: "mutable-sets",
    description: "should diff when the caller mutates and reuses the same Set",
    options() {
      return { experiments: { nativeWatcher: false } };
    },
    build(context, compiler) {
      const WatchFileSystem = compiler.watchFileSystem.constructor;
      const fs = new WatchFileSystem(compiler.inputFileSystem);
      const files = new Set();
      const directories = new Set();
      const missing = new Set();
      const options = { aggregateTimeout: 30 };
      const arm = (opts = options) => fs.watch(files, directories, missing, Date.now(), opts, () => {}, () => {});
      const handle = arm();
      try {
        const watcher = fs.watcher;
        const watch = watcher.watch;
        let calls = 0;
        watcher.watch = function(...args) { calls++; return watch.apply(this, args); };
        const file = path.join(compiler.context, "a.js");
        files.add(file);
        arm();
        expect(calls).toBe(1);
        expect(watcher.fileWatchers.has(file)).toBe(true);
        files.clear();
        arm();
        expect(fs.getTimes()).toEqual({});
        expect(fs.getTimeInfoEntries().size).toBe(0);
        const fileTimes = new Map();
        const directoryTimes = new Map();
        fs.collectTimeInfoEntries(fileTimes, directoryTimes);
        expect(fileTimes.size).toBe(0);
        expect(directoryTimes.size).toBe(0);
        handle.pause();
        arm();
        expect(fs.watcher).toBe(watcher);
        arm({ aggregateTimeout: 30 });
        expect(fs.watcher).not.toBe(watcher);
      } finally {
        handle.close();
      }
    }
  }
];
