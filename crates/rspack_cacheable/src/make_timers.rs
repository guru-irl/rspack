//! Measurement-only, process-wide make counters. Use one compiler at a time.

use std::{
  fs::OpenOptions,
  io::Write,
  path::PathBuf,
  sync::{
    OnceLock,
    atomic::{AtomicU64, Ordering::Relaxed},
  },
  time::Instant,
};

static OUTPUT: OnceLock<Option<PathBuf>> = OnceLock::new();
static MAKE_SEQ: AtomicU64 = AtomicU64::new(0);

#[inline]
pub fn enabled() -> bool {
  output().is_some()
}

fn output() -> &'static Option<PathBuf> {
  OUTPUT.get_or_init(|| std::env::var_os("RSPACK_MAKE_TIMERS").map(PathBuf::from))
}

pub struct Metric {
  calls: AtomicU64,
  nanos: AtomicU64,
}

impl Metric {
  const fn new() -> Self {
    Self {
      calls: AtomicU64::new(0),
      nanos: AtomicU64::new(0),
    }
  }

  #[inline]
  pub fn start(&'static self) -> Option<Timer> {
    if enabled() {
      Some(Timer {
        metric: self,
        start: Instant::now(),
      })
    } else {
      None
    }
  }

  fn take(&self) -> (u64, f64) {
    (
      self.calls.swap(0, Relaxed),
      self.nanos.swap(0, Relaxed) as f64 / 1_000_000.0,
    )
  }
}

pub struct Timer {
  metric: &'static Metric,
  start: Instant,
}

impl Drop for Timer {
  fn drop(&mut self) {
    self
      .metric
      .nanos
      .fetch_add(self.start.elapsed().as_nanos() as u64, Relaxed);
    self.metric.calls.fetch_add(1, Relaxed);
  }
}

pub static MAIN: Metric = Metric::new();
pub static RESTORE: Metric = Metric::new();
pub static RESTORE_GET: Metric = Metric::new();
pub static NEED_BUILD: Metric = Metric::new();
pub static FACTORIZE: Metric = Metric::new();
pub static JSON_DECODE: Metric = Metric::new();
pub static RESTORE_HITS: AtomicU64 = AtomicU64::new(0);
pub static JSON_BYTES: AtomicU64 = AtomicU64::new(0);
pub static RESOLVER_GETS: AtomicU64 = AtomicU64::new(0);
pub static RESOLVER_HITS: AtomicU64 = AtomicU64::new(0);
pub static RESOLVER_SETS: AtomicU64 = AtomicU64::new(0);

pub struct MakeTimer {
  start: Instant,
  name: Option<String>,
}

impl MakeTimer {
  #[inline]
  pub fn start(name: Option<&str>) -> Option<Self> {
    if enabled() {
      Some(Self {
        start: Instant::now(),
        name: name.map(str::to_owned),
      })
    } else {
      None
    }
  }
}

impl Drop for MakeTimer {
  fn drop(&mut self) {
    let make_wall_ms = self.start.elapsed().as_secs_f64() * 1000.0;
    let (main_tasks, main_busy_ms) = MAIN.take();
    let (restore_calls, restore_ms) = RESTORE.take();
    let (_, restore_get_ms) = RESTORE_GET.take();
    let (_, restore_need_build_ms) = NEED_BUILD.take();
    let (factorize_tasks, factorize_sum_ms) = FACTORIZE.take();
    let (json_decodes, json_decode_ms) = JSON_DECODE.take();
    let line = serde_json::json!({
      "pid": std::process::id(),
      "make_seq": MAKE_SEQ.fetch_add(1, Relaxed) + 1,
      "name": self.name,
      "make_wall_ms": make_wall_ms,
      "main_tasks": main_tasks,
      "main_busy_ms": main_busy_ms,
      "restore_calls": restore_calls,
      "restore_hits": RESTORE_HITS.swap(0, Relaxed),
      "restore_ms": restore_ms,
      "restore_get_ms": restore_get_ms,
      "restore_need_build_ms": restore_need_build_ms,
      "factorize_tasks": factorize_tasks,
      "factorize_sum_ms": factorize_sum_ms,
      "json_decodes": json_decodes,
      "json_bytes": JSON_BYTES.swap(0, Relaxed),
      "json_decode_ms": json_decode_ms,
      "resolver_cache_gets": RESOLVER_GETS.swap(0, Relaxed),
      "resolver_cache_hits": RESOLVER_HITS.swap(0, Relaxed),
      "resolver_cache_sets": RESOLVER_SETS.swap(0, Relaxed),
    });
    let path = output().as_ref().expect("make timers enabled");
    let result = OpenOptions::new()
      .create(true)
      .append(true)
      .open(path)
      .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(error) = result {
      eprintln!("Failed to write make timers: {error}");
    }
  }
}
