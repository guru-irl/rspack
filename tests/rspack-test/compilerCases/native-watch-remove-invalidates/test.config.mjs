import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rspack } from "@rspack/core";

/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
  name: "dependency-order",
  description: "should block native-watched dependants immediately when a shared module is removed",
  async run() {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "rspack-native-remove-"))
    );
    const events = [];
    let compiler;
    let watching;
    let removed = false;
    let clientDone = false;
    let resolveRebuild;
    let rejectBuild;

    async function bounded(promise) {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Watch build timed out: ${events.join(", ")}`));
            }, 15000);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      fs.writeFileSync(path.join(root, "shared.js"), "export default 1;");
      for (const name of ["client", "server"]) {
        fs.writeFileSync(
          path.join(root, `${name}.js`),
          'import shared from "./shared.js"; console.log(shared);'
        );
      }
      compiler = rspack(["client", "server"].map(name => ({
        name,
        dependencies: name === "server" ? ["client"] : [],
        context: root,
        entry: `./${name}.js`,
        mode: "development",
        devtool: false,
        output: { path: path.join(root, "dist", name) },
        experiments: { nativeWatcher: true }
      })));
      for (const child of compiler.compilers) {
        child.hooks.compile.tap("NativeWatchRemoveInvalidates", () => {
          if (removed) events.push(`${child.name}:compile`);
        });
        child.hooks.done.tap("NativeWatchRemoveInvalidates", () => {
          if (!removed) return;
          events.push(`${child.name}:done`);
          if (child.name === "client") clientDone = true;
          if (child.name === "server" && clientDone) resolveRebuild();
        });
      }

      const initialStats = await bounded(new Promise((resolve, reject) => {
        rejectBuild = reject;
        // Force server's aggregate to arrive first, independent of watcher
        // registration order. Raw invalidation must still hold it for client.
        watching = compiler.watch(
          [{ aggregateTimeout: 800 }, { aggregateTimeout: 50 }],
          (error, stats) => {
            if (error) rejectBuild(error);
            else resolve(stats);
          }
        );
      }));
      expect(initialStats.hasErrors()).toBe(false);
      // Watching installs the next watch in a nextTick after its callback.
      await new Promise(resolve => setImmediate(resolve));
      const rebuilt = new Promise((resolve, reject) => {
        resolveRebuild = resolve;
        rejectBuild = reject;
      });
      removed = true;
      fs.unlinkSync(path.join(root, "shared.js"));
      // Missing-module diagnostics are expected; only fatal watcher errors
      // reject the build. Without the fix, both server passes finish before
      // `rebuilt` resolves.
      await bounded(rebuilt);

      expect(events.filter(event => event === "server:compile")).toHaveLength(1);
      expect(events.indexOf("server:compile")).toBeGreaterThan(
        events.indexOf("client:done")
      );
    } finally {
      if (watching) {
        await new Promise((resolve, reject) => {
          watching.close(error => error ? reject(error) : resolve());
        });
      } else if (compiler) {
        await new Promise((resolve, reject) => {
          compiler.close(error => error ? reject(error) : resolve());
        });
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  }
};
