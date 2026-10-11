// Bench-only diagnostics. Phase spans may overlap; sampled call durations are CPU estimates.
use std::{
  sync::atomic::{AtomicU64, Ordering},
  time::Instant,
};

use rspack_core::{CompilationLogger, LogType, Logger, Module, ModuleIdentifier};

pub(super) const LABELS: [&str; 13] = [
  "stage0 priority total",
  "stage0 combinator",
  "stage0 matching total",
  "stage0 matching native",
  "stage0 matching JS-bearing",
  "stage0 matching assembly",
  "stage0 candidate initial sizes",
  "stage0 candidate selection",
  "stage0 candidate updates",
  "stage0 split application",
  "stage0 JS test phase",
  "stage0 JS chunks phase",
  "stage0 JS name phase",
];
pub(super) const NATIVE_TEST: usize = 13;
pub(super) const NATIVE_NAME: usize = 14;
const COUNT: usize = 15;

#[derive(Default)]
pub(super) struct Timings {
  nanos: [AtomicU64; COUNT],
  pub(super) names: Names,
}
impl Timings {
  pub(super) fn span(&self, slot: usize) -> Span<'_> {
    Span { nanos: &self.nanos[slot], start: Some(Instant::now()), scale: 1 }
  }
  // Selection/application/update are per-candidate operations. No clock on 15/16 calls.
  pub(super) fn sampled(&self, slot: usize, candidate: usize) -> Span<'_> {
    Span { nanos: &self.nanos[slot], start: (candidate & 15 == 0).then(Instant::now), scale: 16 }
  }
  fn values(&self) -> [u64; COUNT] {
    std::array::from_fn(|i| self.nanos[i].load(Ordering::Relaxed))
  }
  fn emit(logger: &CompilationLogger, values: &[u64; COUNT]) {
    for (label, nanos) in LABELS.iter().copied().chain(["stage0 native test phase", "stage0 native name phase"]).zip(values) {
      time(logger, label, *nanos);
    }
  }
  pub(super) fn report(logger: &CompilationLogger, levels: &[(f64, Self)], shared_names: &Names) {
    let mut total = [0; COUNT];
    let names = Names::default();
    for (_, level) in levels {
      for (sum, value) in total.iter_mut().zip(level.values()) { *sum += value; }
      names.merge(&level.names);
    }
    names.merge(shared_names);
    Self::emit(logger, &total);
    names.report(logger);
    let mut ranked = levels.iter().collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.1.nanos[0].load(Ordering::Relaxed).cmp(&a.1.nanos[0].load(Ordering::Relaxed)).then_with(|| b.0.total_cmp(&a.0)));
    logger.log(format!("stage0 priority levels: {}; top {} by priority wall time", levels.len(), levels.len().min(10)));
    for (priority, level) in ranked.into_iter().take(10) {
      let child = logger.get_child(&format!("priority {priority}"));
      Self::emit(&child, &level.values());
      level.names.report(&child);
    }
  }
}

pub(super) struct Span<'a> {
  nanos: &'a AtomicU64,
  start: Option<Instant>,
  scale: u64,
}
impl Drop for Span<'_> {
  fn drop(&mut self) {
    if let Some(start) = self.start {
      self.nanos.fetch_add(start.elapsed().as_nanos() as u64 * self.scale, Ordering::Relaxed);
    }
  }
}

fn time(logger: &CompilationLogger, label: &'static str, nanos: u64) {
  logger.raw(LogType::Time { label, secs: nanos / 1_000_000_000, subsec_nanos: (nanos % 1_000_000_000) as u32 });
}

#[derive(Default)]
pub(super) struct Names {
  nanos: AtomicU64,
  samples: AtomicU64,
  matcher_nanos: AtomicU64,
  matcher_samples: AtomicU64,
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
  pub(super) fn test(&self, identifier: ModuleIdentifier, test: impl FnOnce() -> bool) -> bool {
    if identifier.precomputed_hash() & 1023 != 0 { return test(); }
    let start = Instant::now();
    let result = test();
    self.matcher_nanos.fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
    self.matcher_samples.fetch_add(1, Ordering::Relaxed);
    result
  }
  fn merge(&self, other: &Self) {
    for (to, from) in [(&self.nanos, &other.nanos), (&self.samples, &other.samples), (&self.matcher_nanos, &other.matcher_nanos), (&self.matcher_samples, &other.matcher_samples)] {
      to.fetch_add(from.load(Ordering::Relaxed), Ordering::Relaxed);
    }
  }
  fn report(&self, logger: &CompilationLogger) {
    time(logger, "stage0 name_for_condition sampled", self.nanos.load(Ordering::Relaxed));
    time(logger, "stage0 native matcher sampled CPU", self.matcher_nanos.load(Ordering::Relaxed));
    logger.log(format!("stage0 name_for_condition samples: {}; native matcher samples: {} (hash 1/1024; raw sampled ns, multiply by 1024 for aggregate CPU estimate)", self.samples.load(Ordering::Relaxed), self.matcher_samples.load(Ordering::Relaxed)));
  }
}
