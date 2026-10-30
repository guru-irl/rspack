'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const file = 'source/crates/rspack_watcher/src/disk_watcher.rs';
let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const cross = !text.includes('#[cfg(target_os = "linux")]\n#[derive(Default)]');
function replace(old, next) {
  assert.equal(text.split(old).length, 2, `one match required: ${old}`);
  text = text.replace(old, next);
}
replace('pub struct DiskWatcher {', `#[derive(Default)]
struct WatchDiagnostics {
  enabled: bool,
  order: bool,
  recursive: usize,
  non_recursive: usize,
  native_ns: u128,
  canonical_count: usize,
  canonical_ns: u128,
  watch_count: usize,
  watch_ns: u128,
}

pub struct DiskWatcher {
  diagnostics: WatchDiagnostics,`);
replace('    DiskWatcher {\n', `    DiskWatcher {
      diagnostics: WatchDiagnostics {
        enabled: std::env::var_os("RSPACK_WATCH_DIAGNOSTICS").is_some(),
        order: std::env::var_os("RSPACK_WATCH_DIAGNOSTICS_ORDER").is_some(),
        ..Default::default()
      },
`);
replace('    self.analyzer_patterns = patterns.collect();', `    let diagnostic_start = self.diagnostics.enabled.then(std::time::Instant::now);
    self.analyzer_patterns = patterns.collect();`);
replace('    for pattern in new_patterns {', `    let mut new_patterns: Vec<_> = new_patterns.into_iter().collect();
    if self.diagnostics.order {
      new_patterns.sort_by_key(|pattern| pattern.mode == NonRecursive);
    }
    for pattern in new_patterns {`);
replace('    self.report_context_watch_errors();\n    Ok(())', `    if let Some(start) = diagnostic_start {
      self.diagnostics.watch_count += 1;
      self.diagnostics.watch_ns += start.elapsed().as_nanos();
      self.report_diagnostics("watch");
    }
    self.report_context_watch_errors();
    Ok(())`);
replace('        InternedPath::from(std::fs::canonicalize(&pattern.path).map_err(notify::Error::io)?);', `        {
          let start = self.diagnostics.enabled.then(std::time::Instant::now);
          let result = std::fs::canonicalize(&pattern.path);
          if let Some(start) = start {
            self.diagnostics.canonical_count += 1;
            self.diagnostics.canonical_ns += start.elapsed().as_nanos();
          }
          InternedPath::from(result.map_err(notify::Error::io)?)
        };`);
replace('watcher.watch(&path, mode)', `{
        let start = self.diagnostics.enabled.then(std::time::Instant::now);
        let result = watcher.watch(&path, mode);
        if let Some(start) = start {
          match mode {
            Recursive => self.diagnostics.recursive += 1,
            NonRecursive => self.diagnostics.non_recursive += 1,
          }
          self.diagnostics.native_ns += start.elapsed().as_nanos();
        }
        result
      }`);
const sizes = `let aliases = self.aliases.lock().expect("watch aliases lock poisoned");
    let sizes = (aliases.native_paths.len(), aliases.native_paths.capacity(), aliases.patterns.len(), aliases.patterns.capacity(), aliases.patterns.values().map(|p| p.len()).sum::<usize>());`;
replace('  pub fn close(&mut self) {', `  fn report_diagnostics(&self, phase: &str) {
    if !self.diagnostics.enabled { return; }
    ${cross ? sizes : `#[cfg(target_os = "linux")]
    ${sizes}
    #[cfg(not(target_os = "linux"))]
    let sizes = (0, 0, 0, 0, 0);`}
    let d = &self.diagnostics;
    eprintln!("WATCH_DIAG {{\\"phase\\":\\"{}\\",\\"ordered\\":{},\\"recursive\\":{},\\"nonRecursive\\":{},\\"nativeNs\\":{},\\"canonicalCount\\":{},\\"canonicalNs\\":{},\\"watchCount\\":{},\\"watchNs\\":{},\\"nativePaths\\":{},\\"nativeCapacity\\":{},\\"patternKeys\\":{},\\"patternCapacity\\":{},\\"patterns\\":{},\\"requirements\\":{},\\"contexts\\":{}}}", phase, d.order, d.recursive, d.non_recursive, d.native_ns, d.canonical_count, d.canonical_ns, d.watch_count, d.watch_ns, sizes.0, sizes.1, sizes.2, sizes.3, sizes.4, self.watch_patterns.len(), self.context_paths.len());
  }

  pub fn close(&mut self) {
    self.report_diagnostics("close");`);
fs.writeFileSync(file, text);
console.log(JSON.stringify({kind: 'diagnostic-patch', file, crossPlatformAliases: cross}));
