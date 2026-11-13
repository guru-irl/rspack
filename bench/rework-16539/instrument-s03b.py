from pathlib import Path
import sys
p=Path(sys.argv[1])/'crates/rspack_watcher/src/disk_watcher.rs'
s=p.read_text(); candidate='struct ContextWatches' in s
assert 'DSTATE' not in s
needle='let new_patterns: HashSet<_> = patterns.collect();' if candidate else 'let new_patterns: HashSet<WatchPattern> = patterns.collect();'
s=s.replace(needle,needle+'\n    eprintln!("DSTATE analyzer {:?}", new_patterns);',1)
s=s.replace('for path in &stale_paths {','for path in &stale_paths {\n      eprintln!("DSTATE primary_unwatch {:?}", path);',1)
needle='  pub fn close(&mut self) {'
state='eprintln!("DSTATE confirmed primary={:?}", self.watch_patterns);'
if candidate:
 state='eprintln!("DSTATE confirmed primary={:?} analyzer={:?} dirty={:?} contexts={:?} optional={:?} disabled={}", self.watch_patterns, self.analyzer_patterns, self.dirty, self.context_paths, self.contexts.lock().unwrap().installed, CONTEXTS_DISABLED.load(Ordering::Acquire));'
a=s.index('  pub fn watch('); b=s.index('  fn watch_pattern' if candidate else needle,a)
s=s[:a]+s[a:b].replace('    Ok(())','    '+state+'\n    Ok(())',1)+s[b:]
if candidate:
 s=s.replace('    let paths = std::mem::take(&mut self.installed);','    eprintln!("DSTATE release optional={:?} disabled={}", self.installed, CONTEXTS_DISABLED.load(Ordering::Acquire));\n    let paths = std::mem::take(&mut self.installed);',1)
 s=s.replace('    let result = self\n      .inner','    eprintln!("DSTATE primary_watch {:?}", pattern);\n    let result = self\n      .inner',1)
 s=s.replace('    result\n  }','    eprintln!("DSTATE primary_result {:?} {:?}", pattern, result);\n    result\n  }',1)
 s=s.replace('  pub(crate) fn repair(&mut self, recursive: bool) -> rspack_error::Result<bool> {','  pub(crate) fn repair(&mut self, recursive: bool) -> rspack_error::Result<bool> {\n    eprintln!("DSTATE repair recursive={} analyzer={:?} confirmed={:?} dirty={:?} disabled={}", recursive, self.analyzer_patterns, self.watch_patterns, self.dirty, CONTEXTS_DISABLED.load(Ordering::Acquire));',1)
 s=s.replace('    match contexts\n      .inner','    eprintln!("DSTATE optional_watch {:?}", path);\n    match contexts\n      .inner',1)
 s=s.replace('      Ok(()) => {\n        contexts','      Ok(()) => {\n        eprintln!("DSTATE optional_success {:?}", path);\n        contexts',1)
 s=s.replace('        CONTEXTS_DISABLED.store(true, Ordering::Release);','        eprintln!("DSTATE optional_limit {:?}", path);\n        CONTEXTS_DISABLED.store(true, Ordering::Release);',1)
else:
 needle='        watcher\n          .watch(&pattern.path, pattern.mode)\n          .map_err(|e| rspack_error::error!(e.to_string()))?;'
 assert needle in s
 s=s.replace(needle,'        eprintln!("DSTATE primary_watch {:?}", pattern);\n        let result = watcher.watch(&pattern.path, pattern.mode);\n        eprintln!("DSTATE primary_result {:?} {:?}", pattern, result);\n        result.map_err(|e| rspack_error::error!(e.to_string()))?;',1)
p.write_text(s)
