import fs from 'node:fs';
import path from 'node:path';

const CASE_NAME = 'native-watcher-recreated-missing-parent';
const wait = () => new Promise((resolve) => setTimeout(resolve, 10));

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Wait for the old inode's watch to retire, not for an assumed event delay.
function hasDirectoryWatch(inode) {
  for (const fd of fs.readdirSync('/proc/self/fdinfo')) {
    let info;
    try {
      info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const line of info.split('\n')) {
      const match = /^inotify wd:.* ino:([a-f0-9]+)/.exec(line);
      if (match && BigInt(`0x${match[1]}`) === inode) return true;
    }
  }
  return false;
}

/** @type {import('@rspack/test-tools').TCompilerCaseConfig} */
export default {
  description:
    'should discover a retained missing child after its parent is recreated',
  options(context) {
    const root = context.getDist(CASE_NAME);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const source = path.join(root, 'source');
    const parent = path.join(source, 'retained');
    const entry = path.join(source, 'control', 'index.js');
    const control = path.join(source, 'control', 'control.txt');
    const child = path.join(parent, 'value.txt');
    const loader = path.join(root, 'missing-loader.cjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(parent);
    fs.writeFileSync(entry, 'module.exports = 1;\n');
    fs.writeFileSync(control, 'initial');
    fs.writeFileSync(
      loader,
      `module.exports = function(source) {
  this.cacheable();
  this.addMissingDependency(${JSON.stringify(child)});
  return source;
};\n`,
    );
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(entry, past, past);
    fs.utimesSync(control, past, past);
    context.setValue('paths', { root, parent, child, control });
    return {
      context: path.dirname(entry),
      mode: 'development',
      devtool: false,
      entry: './index.js',
      output: { path: path.join(root, 'output') },
      experiments: { nativeWatcher: true },
      module: { rules: [{ test: /index\.js$/, use: [loader] }] },
      plugins: [
        (compiler) => {
          let observed;
          compiler.hooks.thisCompilation.tap(CASE_NAME, (compilation) => {
            observed = fs.existsSync(child)
              ? fs.readFileSync(child, 'utf8')
              : 'missing';
            compilation.emitAsset(
              'observed.txt',
              new compiler.webpack.sources.RawSource(observed),
            );
          });
          compiler.hooks.afterCompile.tap(CASE_NAME, (compilation) => {
            // No ancestor context watch may mask lost coverage of the parent.
            compilation.fileDependencies.clear();
            compilation.fileDependencies.add(entry);
            compilation.fileDependencies.add(control);
            compilation.contextDependencies.clear();
            compilation.buildDependencies.clear();
            for (const missing of compilation.missingDependencies) {
              if (missing !== child)
                compilation.missingDependencies.delete(missing);
            }
            if (observed !== 'missing') {
              compilation.missingDependencies.clear();
              compilation.fileDependencies.add(child);
            }
          });
        },
      ],
    };
  },
  async build(context, compiler) {
    const { root, parent, child, control } = context.getValue('paths');
    const held = deferred();
    const release = deferred();
    const builds = [];
    const runs = [];
    const applications = [];
    let failure;
    let watching;
    const until = async (condition, label) => {
      const deadline = Date.now() + 15_000;
      while (!condition()) {
        if (failure) throw failure;
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for ${label}`);
        await wait();
      }
    };
    compiler.hooks.watchRun.tap(CASE_NAME, () => {
      runs.push({
        modified: [...(compiler.modifiedFiles || [])].sort(),
        removed: [...(compiler.removedFiles || [])].sort(),
      });
    });
    compiler.hooks.afterCompile.tapPromise(CASE_NAME, async () => {
      if (runs.length === 2) {
        held.resolve();
        await release.promise;
      }
    });
    const watch = compiler.watchFileSystem.watch;
    compiler.watchFileSystem.watch = function (
      files,
      directories,
      missing,
      ...rest
    ) {
      applications.push({
        missing: [...missing],
        added: [...(missing.added || [])],
      });
      return watch.call(this, files, directories, missing, ...rest);
    };
    watching = compiler.watch({ aggregateTimeout: 40 }, (error, stats) => {
      if (error || stats.hasErrors()) {
        failure = error || new Error(stats.toString());
        return;
      }
      builds.push(
        stats.compilation.getAsset('observed.txt').source.source().toString(),
      );
    });
    try {
      await until(
        () => applications.length >= 1 && watching.watcher && !watching.running,
        'initial watch',
      );
      expect(builds).toEqual(['missing']);
      expect(applications[0].missing).toEqual([child]);
      const oldInode = fs.statSync(parent, { bigint: true }).ino;
      if (process.platform === 'linux') {
        await until(
          () => hasDirectoryWatch(oldInode),
          'initial parent coverage',
        );
      }
      fs.writeFileSync(control, 'start cached rebuild');
      await until(() => runs.length === 2, 'control rebuild');
      await held.promise;
      // A prepared directory guarantees a different inode even on fast reuse.
      const replacement = path.join(root, 'replacement');
      fs.mkdirSync(replacement);
      fs.rmdirSync(parent);
      if (process.platform === 'linux') {
        await until(
          () => !hasDirectoryWatch(oldInode),
          'old parent watch retirement',
        );
      }
      fs.renameSync(replacement, parent);
      fs.writeFileSync(child, 'discovered');
      release.resolve();
      await until(
        () => applications.length >= 2 && builds.length >= 2,
        'watch reapplication',
      );
      expect(builds[1]).toBe('missing');
      expect(applications[1].missing).toEqual([child]);
      expect(applications[1].added).not.toContain(child);
      await until(
        () => builds.includes('discovered'),
        'missing child discovery',
      );
      expect(runs[2]).toEqual({ modified: [child], removed: [] });
      await until(
        () => watching.watcher && !watching.running,
        'discovery watch',
      );
      if (process.platform === 'linux') {
        const inode = fs.statSync(parent, { bigint: true }).ino;
        await until(
          () => hasDirectoryWatch(inode),
          'recreated parent coverage',
        );
      }
      const laterRun = runs.length;
      fs.writeFileSync(child, 'later-edit');
      await until(() => builds.includes('later-edit'), 'later child edit');
      expect(runs[laterRun]).toEqual({ modified: [child], removed: [] });
    } finally {
      release.resolve();
      compiler.watchFileSystem.watch = watch;
      await new Promise((resolve, reject) =>
        watching.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  async check({ files }) {
    const asset = Object.entries(files).find(
      ([file]) => path.basename(file) === 'observed.txt',
    );
    expect(asset?.[1]).toBe('later-edit');
  },
};
