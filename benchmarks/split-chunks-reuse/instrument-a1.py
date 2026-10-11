from pathlib import Path
import sys
root = Path(sys.argv[1])
p = root / 'crates/rspack_plugin_split_chunks/src/plugin'
(p / 'a1_timing.rs').write_text('''use rspack_core::{Compilation, CompilationLogger, Logger};
pub(super) struct Span {
  logger: CompilationLogger,
  start: Option<rspack_core::StartTime>,
}
impl Span {
  pub(super) fn new(compilation: &Compilation, label: &'static str) -> Self {
    let logger = compilation.get_logger("rspack.SplitChunksPlugin");
    let start = Some(logger.time(label));
    Self { logger, start }
  }
}
impl Drop for Span {
  fn drop(&mut self) {
    self.logger.time_end(self.start.take().expect("one timing span"));
  }
}
''')
f = p / 'mod.rs'
s = f.read_text().replace('mod bitmap;', 'mod a1_timing;\nmod bitmap;')
s = s.replace('      let mut module_group_map = self', '      let matching_timer = logger.time("stage0 matching total");\n      let mut module_group_map = self')
s = s.replace('      tracing::trace!("prepared module_group_map', '      logger.time_end(matching_timer);\n      tracing::trace!("prepared module_group_map')
f.write_text(s)
f = p / 'module_group.rs'
s = f.read_text()
if 'let native_positions' in s:
    s = s.replace('    if !native_positions.is_empty() {', '    if !native_positions.is_empty() {\n      let _timer = super::a1_timing::Span::new(compilation, "stage0 matching native");', 1)
else:
    s = s.replace('    if use_native_preparation {\n      all_modules', '    let matching_timer = super::a1_timing::Span::new(compilation, if use_native_preparation { "stage0 matching native" } else { "stage0 matching JS-bearing" });\n    if use_native_preparation {\n      all_modules', 1)
    s = s.replace('    let module_group_count = module_group_map.len();', '    drop(matching_timer);\n    let module_group_count = module_group_map.len();', 1)
f.write_text(s)
print('Instrumented source:', root)
