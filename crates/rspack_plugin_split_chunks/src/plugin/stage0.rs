// Bench-only timing. Async spans include suspension; do not sum overlapping spans.
use std::{sync::atomic::{AtomicU64, Ordering}, time::Instant};
use rspack_core::{Compilation, CompilationLogger, Logger, Module, ModuleIdentifier};

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
#[derive(Default)]
pub(super) struct Names {
  nanos: AtomicU64,
  samples: AtomicU64,
  matcher_nanos: AtomicU64,
}
impl Names {
  pub(super) fn get(&self, module: &dyn Module, identifier: ModuleIdentifier) -> Option<Box<str>> {
    if identifier.precomputed_hash() & 1023 != 0 { return module.name_for_condition(); }
    let start = Instant::now();
    let result = module.name_for_condition();
    self.nanos.fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
    self.samples.fetch_add(1, Ordering::Relaxed);
    result
  }
  pub(super) fn test(&self, module: &dyn Module, identifier: ModuleIdentifier, test: impl FnOnce(Box<str>) -> bool) -> bool {
    if identifier.precomputed_hash() & 1023 != 0 { return self.get(module, identifier).is_some_and(test); }
    let start = Instant::now();
    let result = self.get(module, identifier).is_some_and(test);
    self.matcher_nanos.fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
    result
  }
  pub(super) fn report(&self, compilation: &Compilation) {
    let logger = compilation.get_logger("rspack.SplitChunksPlugin");
    logger.raw(rspack_core::LogType::Time { label: "stage0 name_for_condition sampled", secs: 0,
      subsec_nanos: self.nanos.load(Ordering::Relaxed) as u32 });
    let nanos = self.matcher_nanos.load(Ordering::Relaxed);
    logger.raw(rspack_core::LogType::Time { label: "stage0 native matcher sampled CPU", secs: nanos / 1_000_000_000,
      subsec_nanos: (nanos % 1_000_000_000) as u32 });
    logger.log(format!("stage0 name_for_condition samples: {} (hash 1/1024)", self.samples.load(Ordering::Relaxed)));
  }
}

#[derive(Default)]
pub(super) struct Callbacks {
  test: AtomicU64,
  chunks: AtomicU64,
  name: AtomicU64,
}
pub(super) struct AwaitSpan<'a> {
  nanos: &'a AtomicU64,
  start: Instant,
}
impl Drop for AwaitSpan<'_> {
  fn drop(&mut self) { self.nanos.fetch_add(self.start.elapsed().as_nanos() as u64, Ordering::Relaxed); }
}
impl Callbacks {
  pub(super) fn test(&self) -> AwaitSpan<'_> { AwaitSpan { nanos: &self.test, start: Instant::now() } }
  pub(super) fn chunks(&self) -> AwaitSpan<'_> { AwaitSpan { nanos: &self.chunks, start: Instant::now() } }
  pub(super) fn name(&self) -> AwaitSpan<'_> { AwaitSpan { nanos: &self.name, start: Instant::now() } }
  pub(super) fn report(&self, compilation: &Compilation) {
    let logger = compilation.get_logger("rspack.SplitChunksPlugin");
    for (label, counter) in [("stage0 JS test overlapping awaits", &self.test), ("stage0 JS chunks overlapping awaits", &self.chunks), ("stage0 JS name overlapping awaits", &self.name)] {
      let nanos = counter.load(Ordering::Relaxed);
      logger.raw(rspack_core::LogType::Time { label, secs: nanos / 1_000_000_000, subsec_nanos: (nanos % 1_000_000_000) as u32 });
    }
  }
}
