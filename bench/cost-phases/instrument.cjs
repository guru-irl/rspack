'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
require('../wide-memory/instrument.cjs');
const disk='source/crates/rspack_watcher/src/disk_watcher.rs';
let text=fs.readFileSync(disk,'utf8');
function replace(old,next){assert.equal(text.split(old).length,2,old);text=text.replace(old,next);}
replace('  watch_count: usize,','  context_count: usize,\n  context_ns: u128,\n  watch_count: usize,');
replace('    if self.inner.is_none() {\n      return Ok(false);','    let diagnostic_start = self.diagnostics.enabled.then(std::time::Instant::now);\n    if self.inner.is_none() {\n      return Ok(false);');
replace('      aliases\n        .patterns\n        .entry(path.clone())', `      let identity_spelling = pattern.path.as_path() == path.as_path()
        || (cfg!(target_os = "windows")
          && path.to_str().and_then(|p| p.strip_prefix(r"\\\\?\\")) == pattern.path.to_str());
      if std::env::var_os("RSPACK_WATCH_DIAGNOSTICS_PRUNE").is_some()
        && pattern.mode == NonRecursive
        && identity_spelling
        && path.ancestors().any(|ancestor| {
          aliases.patterns.get(&InternedPath::from(ancestor))
            .is_some_and(|patterns| patterns.iter().any(|p| p.mode == Recursive))
        })
      {
        self.diagnostics.covered += 1;
        return Ok(());
      }
      aliases
        .patterns
        .entry(path.clone())`);
replace('    Ok(self.context_paths.insert(path.clone()))',`    let added = self.context_paths.insert(path.clone());
    if let Some(start) = diagnostic_start {
      self.diagnostics.context_count += 1;
      self.diagnostics.context_ns += start.elapsed().as_nanos();
    }
    Ok(added)`);
replace('    eprintln!("WATCH_COVERAGE covered={} uncoveredAfterRoot={}", d.covered, d.uncovered_after_root);','    eprintln!("WATCH_COVERAGE covered={} uncoveredAfterRoot={}", d.covered, d.uncovered_after_root);\n    eprintln!("WATCH_CONTEXT count={} ns={}", d.context_count, d.context_ns);');
fs.writeFileSync(disk,text);
const lib='source/crates/rspack_watcher/src/lib.rs';text=fs.readFileSync(lib,'utf8').replace(/\r\n/g,'\n');
replace('    self.record_initial_file_mtimes();',`    let diagnostic_start = std::time::Instant::now();
    self.record_initial_file_mtimes();
    if std::env::var_os("RSPACK_WATCH_DIAGNOSTICS").is_some() {
      eprintln!("WATCH_PHASE initial_mtimes ns={}", diagnostic_start.elapsed().as_nanos());
    }`);
replace('    let watch_patterns = self.analyzer.analyze(self.path_manager.access());',`    let diagnostic_start = std::time::Instant::now();
    let watch_patterns = self.analyzer.analyze(self.path_manager.access());
    if std::env::var_os("RSPACK_WATCH_DIAGNOSTICS").is_some() {
      eprintln!("WATCH_PHASE analyzer ns={}", diagnostic_start.elapsed().as_nanos());
    }`);
replace('    let changed_in_contexts = self.path_manager.scan_contexts(start_time).await;',`    let diagnostic_start = std::time::Instant::now();
    let changed_in_contexts = self.path_manager.scan_contexts(start_time).await;
    if std::env::var_os("RSPACK_WATCH_DIAGNOSTICS").is_some() {
      eprintln!("WATCH_PHASE contexts ns={}", diagnostic_start.elapsed().as_nanos());
    }`);
fs.writeFileSync(lib,text);
console.log('PHASE_PATCH_APPLIED');
