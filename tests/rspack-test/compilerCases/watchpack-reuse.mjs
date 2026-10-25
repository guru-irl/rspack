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

function watchCase(description, run) {
  return {
    description,
    options() {
      return { experiments: { nativeWatcher: false } };
    },
    async build(context, compiler) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rspack-watchpack-reuse-")));
      const entry = path.join(root, "entry.js");
      const dep = path.join(root, "dep.js");
      fs.writeFileSync(entry, "module.exports = 1;\n");
      fs.writeFileSync(dep, "module.exports = 2;\n");
      compiler.options.entry.main.import = [entry];
      const WatchFileSystem = compiler.watchFileSystem.constructor;
      compiler.watchFileSystem = new WatchFileSystem(compiler.inputFileSystem, { reuse: true });
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
        start();
        await wait(1);
        expect(builds[0].hasErrors()).toBe(false);
        await run({ compiler, entry, dep, builds, wait, quiet, start, get watching() { return watching; } });
      } finally {
        if (watching && !watching.closed) await close(watching);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  };
}

export default [
  watchCase("should reuse the same options and replace cycle handlers", async ({ compiler, entry, wait, quiet }) => {
    const first = compiler.watchFileSystem.watcher;
    fs.writeFileSync(entry, "module.exports = 3;\n");
    await wait(2);
    expect(compiler.watchFileSystem.watcher).toBe(first);
    expect(first.listenerCount("change")).toBe(2);
    expect(first.listenerCount("aggregated")).toBe(2);
    await quiet(2);
  }),
  watchCase("should flush an edit made during a held rebuild exactly once", async ({ compiler, entry, watching, wait, quiet }) => {
    let release;
    let held = false;
    compiler.hooks.make.tapPromise("WatchpackReuseTest", async () => {
      if (held) return;
      held = true;
      await new Promise(resolve => { release = resolve; });
    });
    watching.invalidate();
    await until(() => release);
    try {
      fs.writeFileSync(entry, "module.exports = 4;\n");
      await until(() => compiler.watchFileSystem.watcher.aggregatedChanges.has(entry));
    } finally {
      release();
    }
    await wait(3);
    await quiet(3);
  }),
  watchCase("should consume paused changes on manual invalidate without replay", async ({ compiler, entry, watching, wait, quiet }) => {
    const watcher = compiler.watchFileSystem.watcher;
    watcher.pause();
    fs.writeFileSync(entry, "module.exports = 5;\n");
    await until(() => watcher.aggregatedChanges.has(entry));
    watching.invalidate();
    await wait(2);
    expect(compiler.modifiedFiles.has(entry)).toBe(true);
    await quiet(2);
  }),
  watchCase("should watch an added dependency and stop watching a removed dependency", async ({ compiler, entry, dep, wait, quiet }) => {
    fs.writeFileSync(entry, 'module.exports = require("./dep.js");\n');
    await wait(2);
    fs.writeFileSync(dep, "module.exports = 6;\n");
    await wait(3);
    fs.writeFileSync(entry, "module.exports = 7;\n");
    await wait(4);
    expect(compiler.watchFileSystem.watcher.fileWatchers.has(dep)).toBe(false);
    fs.writeFileSync(dep, "module.exports = 8;\n");
    await quiet(4);
  }),
  watchCase("should rebuild after deleting a watched file", async ({ compiler, entry, builds, wait, quiet }) => {
    fs.unlinkSync(entry);
    await wait(2);
    expect(builds[1].hasErrors()).toBe(true);
    expect(compiler.removedFiles.has(entry)).toBe(true);
    await quiet(2);
  }),
  watchCase("should close and watch again with a fresh instance", async state => {
    const first = state.compiler.watchFileSystem.watcher;
    await close(state.watching);
    expect(state.compiler.watchFileSystem.watcher).toBeFalsy();
    state.start();
    await state.wait(2);
    expect(state.compiler.watchFileSystem.watcher).not.toBe(first);
    fs.writeFileSync(state.entry, "module.exports = 9;\n");
    await state.wait(3);
    await state.quiet(3);
  }),
  {
    description: "should replace the instance when options identity changes and honor explicit opt-out",
    options() {
      return { experiments: { nativeWatcher: false } };
    },
    build(context, compiler) {
      const WatchFileSystem = compiler.watchFileSystem.constructor;
      for (const reuse of [false, true]) {
        const watcher = new WatchFileSystem(compiler.inputFileSystem, { reuse });
        const options = { aggregateTimeout: 30 };
        const arm = opts => watcher.watch([], [], [], Date.now(), opts, () => {}, () => {});
        let handle = arm(options);
        try {
          const first = watcher.watcher;
          handle.pause();
          handle = arm(options);
          expect(watcher.watcher === first).toBe(reuse);
          const second = watcher.watcher;
          handle = arm({ aggregateTimeout: 30 });
          expect(watcher.watcher).not.toBe(second);
        } finally {
          handle.close();
        }
      }
    }
  }
];
