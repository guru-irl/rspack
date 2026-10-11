from pathlib import Path

def replace(path, old, new):
    p=Path(path); text=p.read_text(); assert old in text,(path,old); p.write_text(text.replace(old,new,1))
replace('crates/rspack_sources/src/lib.rs','mod cached_source;', '''mod cached_source;
#[doc(hidden)]
pub mod study_probe {
  use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
  static ACTIVE: AtomicBool = AtomicBool::new(false);
  static COMPOSE: AtomicUsize = AtomicUsize::new(0);
  static HIT: AtomicUsize = AtomicUsize::new(0);
  static MISS: AtomicUsize = AtomicUsize::new(0);
  pub fn begin() {
    if std::env::var_os("STUDY_CACHE_PROBE").is_none() { return; }
    COMPOSE.store(0, Ordering::Relaxed); HIT.store(0, Ordering::Relaxed); MISS.store(0, Ordering::Relaxed); ACTIVE.store(true, Ordering::Relaxed);
  }
  pub fn composition() { if ACTIVE.load(Ordering::Relaxed) { COMPOSE.fetch_add(1, Ordering::Relaxed); } }
  pub fn cached(hit: bool) { if ACTIVE.load(Ordering::Relaxed) { (if hit { &HIT } else { &MISS }).fetch_add(1, Ordering::Relaxed); } }
  pub fn end() {
    if ACTIVE.swap(false, Ordering::Relaxed) { eprintln!("STUDY_CACHE compose {} hit {} miss {}", COMPOSE.load(Ordering::Relaxed), HIT.load(Ordering::Relaxed), MISS.load(Ordering::Relaxed)); }
  }
}''')
replace('crates/rspack_sources/src/source_map_source.rs','    if let Some(inner_source_map) = self.inner_source_map {','    if let Some(inner_source_map) = self.inner_source_map {\n      crate::study_probe::composition();')
replace('crates/rspack_sources/src/cached_source.rs','    match cell.get() {','    crate::study_probe::cached(cell.get().is_some());\n    match cell.get() {')
replace('crates/rspack_plugin_devtool/src/source_map_dev_tool_plugin.rs','  let logger = compilation.get_logger(PLUGIN_NAME);','  rspack_core::rspack_sources::study_probe::begin();\n  let logger = compilation.get_logger(PLUGIN_NAME);')
replace('crates/rspack_plugin_devtool/src/source_map_dev_tool_plugin.rs','  logger.time_end(start);\n\n  Ok(())','  logger.time_end(start);\n  rspack_core::rspack_sources::study_probe::end();\n\n  Ok(())')
