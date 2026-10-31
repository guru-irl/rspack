'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve('source/crates/rspack_watcher/src');
function once(text,old,replacement){assert.equal(text.split(old).length,2,old);return text.replace(old,replacement);}
const cfg='#[cfg(any(target_os = "macos", target_os = "windows"))]';
const stamp=name=>`    ${cfg}\n    let ${name} = if cost_first { cost_epoch_us() } else { 0 };`;
let lib=fs.readFileSync(path.join(root,'lib.rs'),'utf8').replace(/\r\n/g,'\n');
const entry='  ) -> Result<()> {\n    self\n      .path_manager\n      .update(';
lib=once(lib,entry,`  ) -> Result<()> {\n    ${cfg}\n    let cost_first = !COST_TIMELINE_FIRST.swap(true, std::sync::atomic::Ordering::Relaxed);\n${stamp('cost_watch_start')}\n    self\n      .path_manager\n      .update(`);
lib=once(lib,'    self.record_initial_file_mtimes();',`${stamp('cost_update_end')}\n    self.record_initial_file_mtimes();\n${stamp('cost_mtime_end')}`);
const analyze='    let watch_patterns = self.analyzer.analyze(self.path_manager.access());';
lib=once(lib,analyze,`${analyze}\n${stamp('cost_analyzer_end')}`);
lib=once(lib,'    if let Err(error) = watch_result {',`${stamp('cost_install_end')}\n    if let Err(error) = watch_result {`);
const scan='    let changed_in_contexts = self.path_manager.scan_contexts(start_time).await;';
const names=['watchStartUs','updateEndUs','mtimeEndUs','analyzerEndUs','installEndUs','scanEndUs','changedInContexts','canonicalCount','canonicalNs','metadataCount','metadataNs','existingOwnLinkCount','existingOwnLinkNs','missingOwnLinkCount','missingOwnLinkNs','ancestorLinkCount','ancestorLinkNs','queryCountersEnabled'];
const values=['cost_watch_start','cost_update_end','cost_mtime_end','cost_analyzer_end','cost_install_end','cost_scan_end','changed_in_contexts.len()',...Array.from({length:10},(_,i)=>`cost_stats[${i}]`),'cfg!(target_os = "windows")'];
assert.equal(names.length,values.length);
lib=once(lib,scan,`${scan}\n${stamp('cost_scan_end')}\n    ${cfg}\n    if cost_first {\n      let cost_stats = cost_query_stats();\n      eprintln!(r#"WATCH_TIMELINE {{${names.map(n=>`"${n}":{}`).join(',')}}}"#, ${values.join(', ')});\n    }`);
lib+=String.raw`
#[cfg(any(target_os = "macos", target_os = "windows"))]
static COST_TIMELINE_FIRST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn cost_epoch_us() -> u128 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock after epoch").as_micros()
}
#[cfg(target_os = "windows")]
static COST_QUERIES: [std::sync::atomic::AtomicU64; 10] = [const { std::sync::atomic::AtomicU64::new(0) }; 10];
#[cfg(target_os = "windows")]
pub(crate) fn cost_query<T>(metric: usize, operation: impl FnOnce() -> T) -> T {
  let start = std::time::Instant::now();
  let result = operation();
  COST_QUERIES[metric].fetch_add(1, std::sync::atomic::Ordering::Relaxed);
  COST_QUERIES[metric + 1].fetch_add(start.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
  result
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn cost_query_stats() -> [u64; 10] {
  #[cfg(target_os = "windows")]
  { std::array::from_fn(|i| COST_QUERIES[i].load(std::sync::atomic::Ordering::Relaxed)) }
  #[cfg(not(target_os = "windows"))]
  { [0; 10] }
}
`;
fs.writeFileSync(path.join(root,'lib.rs'),lib);
const timed=(expression,metric)=>`{\n      #[cfg(target_os = "windows")]\n      { crate::cost_query(${metric}, || ${expression}) }\n      #[cfg(not(target_os = "windows"))]\n      { ${expression} }\n    }`;
let disk=fs.readFileSync(path.join(root,'disk_watcher.rs'),'utf8').replace(/\r\n/g,'\n');
const canonical='std::fs::canonicalize(&pattern.path)';
disk=once(disk,canonical,timed(canonical,'0'));
fs.writeFileSync(path.join(root,'disk_watcher.rs'),disk);
let directories=fs.readFileSync(path.join(root,'analyzer/directories.rs'),'utf8').replace(/\r\n/g,'\n');
directories=once(directories,'let metadata = path.metadata();',`let metadata = ${timed('path.metadata()','2')};`);
directories=once(directories,'let non_directory_symlink = path.is_symlink();',`let non_directory_symlink = ${timed('path.is_symlink()','if metadata.is_ok() { 4 } else { 6 }')};`);
directories=once(directories,'let has_symlink = path.is_symlink()',`let has_symlink = ${timed('path.is_symlink()','8')}`);
fs.writeFileSync(path.join(root,'analyzer/directories.rs'),directories);
console.log('TIMELINE_INSTRUMENTATION_APPLIED');
