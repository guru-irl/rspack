from pathlib import Path

manifest = Path('Cargo.toml')
s = manifest.read_text()
old = 'turbo-persistence   = { package = "rspack-turbo-persistence", version = "0.1.1", default-features = false }'
assert old in s
manifest.write_text(s.replace(old, old[:-2] + ', features = ["stats"] }'))
source = Path('crates/rspack_core/src/new_cache/db/turbo.rs')
s = source.read_text()
old = '  pub fn shutdown(self) -> Result<()> {\n    self.inner.clear_cache();'
assert old in s
source.write_text(s.replace(old, '  pub fn shutdown(self) -> Result<()> {\n    println!("MEMORY_DIAGNOSTIC {:#?}", self.inner.statistics());\n    self.inner.clear_cache();'))
source = Path('crates/rspack_core/src/new_cache/file_cache_strategy.rs')
s = source.read_text()
s = s.replace('      if let Err(error) = state.database.compact() {', '      self.logger.log("Measurement compaction begin");\n      if let Err(error) = state.database.compact() {')
s = s.replace('    if check_idle_ended() {\n      return Ok(());\n    }\n    if let Err(error) = state.database.cleanup_stale()', '    self.logger.log("Measurement compaction passes complete");\n    if check_idle_ended() {\n      return Ok(());\n    }\n    if let Err(error) = state.database.cleanup_stale()')
source.write_text(s)
source = Path('crates/rspack_core/src/new_cache/idle_file_cache.rs')
s = source.read_text().replace('    self.time_spent_in_build = Duration::ZERO;', '    self.logger.log("Measurement idle complete");\n    self.time_spent_in_build = Duration::ZERO;')
source.write_text(s)
print('Diagnostic-only TP stats, compaction-pass and idle-completion events enabled')
