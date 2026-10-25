from pathlib import Path
p = Path('tests/rspack-test/compilerCases/watchpack-reuse.mjs')
s = p.read_text()
old = '    watcher.pause();\n'
assert s.count(old) == 1
new = '''    const log = (tag, extra = {}) => console.log("WATCH_TRACE", JSON.stringify({ tag, time: Date.now(), paused: watcher.paused, changes: [...watcher.aggregatedChanges], removals: [...watcher.aggregatedRemovals], ...extra }));
    const onChange = watcher._onChange.bind(watcher);
    watcher._onChange = (...args) => { log("change-before", { args }); const value = onChange(...args); log("change-after"); return value; };
    const onRemove = watcher._onRemove.bind(watcher);
    watcher._onRemove = (...args) => { log("remove-before", { args }); const value = onRemove(...args); log("remove-after"); return value; };
    const handle = watching.watcher;
    const getInfo = handle.getInfo;
    handle.getInfo = () => { log("info-before"); const value = getInfo(); log("info-after", { returned: [...value.changes] }); return value; };
    const watch = compiler.watchFileSystem.watch.bind(compiler.watchFileSystem);
    compiler.watchFileSystem.watch = (...args) => { log("watch-before"); const value = watch(...args); log("watch-after"); return value; };
    compiler.hooks.watchRun.tap("WatchTrace", () => log("watch-run", { modified: [...(compiler.modifiedFiles || [])] }));
    compiler.hooks.done.tap("WatchTrace", () => log("done"));
    watcher.on("aggregated", () => log("aggregated"));
    log("pause");
    watcher.pause();
'''
p.write_text(s.replace(old, new))
