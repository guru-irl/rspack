from pathlib import Path

source = Path('crates/rspack_core/src/new_cache/file_cache_strategy.rs')
s = source.read_text()
old = '      if let Err(error) = state.database.compact() {'
assert old in s
s = s.replace(old, '      let pass = self.logger.time("measurement compaction pass");\n' + old)
old = '    if check_idle_ended() {\n      return Ok(());\n    }\n    if let Err(error) = state.database.cleanup_stale()'
assert old in s
# Close the per-pass timer after each successful compact call.
old_pass_end = '        break;\n      }\n    }\n    if check_idle_ended()'
assert old_pass_end in s
s = s.replace(old_pass_end, '        break;\n      }\n      self.logger.time_end(pass);\n    }\n    if check_idle_ended()')
source.write_text(s)
source = Path('crates/rspack_core/src/new_cache/idle_file_cache.rs')
s = source.read_text()
old = '    self.time_spent_in_build = Duration::ZERO;'
assert old in s
source.write_text(s.replace(old, '    self.logger.log("Measurement idle complete");\n' + old))
print('Uniform phase-observation markers applied to all arms; no stats feature in acceptance bindings')
