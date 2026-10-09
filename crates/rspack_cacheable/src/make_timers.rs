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
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    self.start_with(None)
  }

  #[inline]
  pub fn start_with(&'static self, secondary: Option<&'static Metric>) -> Option<Timer> {
    enabled().then(|| Timer {
      metric: self,
      secondary,
      start: Instant::now(),
    })
  }

  fn record(&self, nanos: u64) {
    self.nanos.fetch_add(nanos, Relaxed);
    self.calls.fetch_add(1, Relaxed);
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
  secondary: Option<&'static Metric>,
  start: Instant,
}

impl Drop for Timer {
  fn drop(&mut self) {
    let nanos = self.start.elapsed().as_nanos() as u64;
    self.metric.record(nanos);
    if let Some(secondary) = self.secondary {
      secondary.record(nanos);
    }
  }
}

pub static MAIN: Metric = Metric::new();
pub static MAIN_FACTORIZE_RESULT: Metric = Metric::new();
pub static MAIN_ADD: Metric = Metric::new();
pub static MAIN_BUILD_RESULT: Metric = Metric::new();
pub static MAIN_PROCESS_DEPENDENCIES: Metric = Metric::new();
pub static MAIN_EXECUTE: Metric = Metric::new();
pub static MAIN_CTRL: Metric = Metric::new();
pub static MAIN_OVERWRITE: Metric = Metric::new();
pub static MAIN_ENTRY: Metric = Metric::new();
pub static MAIN_OTHER: Metric = Metric::new();
pub static CONNECTIONS: AtomicU64 = AtomicU64::new(0);
pub static RESTORE: Metric = Metric::new();
pub static RESTORE_GET: Metric = Metric::new();
pub static NEED_BUILD: Metric = Metric::new();
pub static STORAGE_WAIT: Metric = Metric::new();
pub static STORAGE_READ: Metric = Metric::new();
pub static STORAGE_DECODE: Metric = Metric::new();
pub static RESTORE_STORAGE_WAIT: Metric = Metric::new();
pub static RESTORE_STORAGE_READ: Metric = Metric::new();
pub static RESTORE_DECODE: Metric = Metric::new();
pub static RESOLVER_STORAGE_WAIT: Metric = Metric::new();
pub static RESOLVER_STORAGE_READ: Metric = Metric::new();
pub static RESOLVER_DECODE: Metric = Metric::new();
pub static FACTORIZE: Metric = Metric::new();
pub static RESOLVE: Metric = Metric::new();
pub static RESOLVE_UNCACHED: Metric = Metric::new();
pub static JSON_DECODE: Metric = Metric::new();
pub static RESTORE_HITS: AtomicU64 = AtomicU64::new(0);
pub static JSON_BYTES: AtomicU64 = AtomicU64::new(0);
pub static RESOLVER_GETS: AtomicU64 = AtomicU64::new(0);
pub static RESOLVER_HITS: AtomicU64 = AtomicU64::new(0);
pub static RESOLVER_SETS: AtomicU64 = AtomicU64::new(0);
pub static RESOLVER_READY_ENTRIES: AtomicU64 = AtomicU64::new(0);
pub static RESOLVER_DECODED_BYTES: AtomicU64 = AtomicU64::new(0);
pub static RESOLVER_DECODED_ENTRIES: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
pub enum StorageKind {
  Module,
  Resolver,
  Other,
}

impl StorageKind {
  pub fn wait_metric(self) -> Option<&'static Metric> {
    match self {
      Self::Module => Some(&RESTORE_STORAGE_WAIT),
      Self::Resolver => Some(&RESOLVER_STORAGE_WAIT),
      Self::Other => None,
    }
  }
  pub fn read_metric(self) -> Option<&'static Metric> {
    match self {
      Self::Module => Some(&RESTORE_STORAGE_READ),
      Self::Resolver => Some(&RESOLVER_STORAGE_READ),
      Self::Other => None,
    }
  }
  pub fn decode_metric(self) -> Option<&'static Metric> {
    match self {
      Self::Module => Some(&RESTORE_DECODE),
      Self::Resolver => Some(&RESOLVER_DECODE),
      Self::Other => None,
    }
  }
}

pub struct MakeTimer {
  start: Instant,
  start_ns: u64,
  clock: fn() -> u64,
  name: Option<String>,
  compilation_id: u32,
}

impl MakeTimer {
  #[inline]
  pub fn start(name: Option<&str>, compilation_id: u32, clock: fn() -> u64) -> Option<Self> {
    enabled().then(|| Self {
      start: Instant::now(),
      start_ns: clock(),
      clock,
      name: name.map(str::to_owned),
      compilation_id,
    })
  }
}

impl Drop for MakeTimer {
  fn drop(&mut self) {
    let end_ns = (self.clock)();
    let make_wall_ms = self.start.elapsed().as_secs_f64() * 1000.0;
    let (main_tasks, main_busy_ms) = MAIN.take();
    let mut main_by_kind = serde_json::Map::new();
    for (kind, metric) in [
      ("factorize_result", &MAIN_FACTORIZE_RESULT),
      ("add", &MAIN_ADD),
      ("build_result", &MAIN_BUILD_RESULT),
      ("process_dependencies", &MAIN_PROCESS_DEPENDENCIES),
      ("execute", &MAIN_EXECUTE),
      ("ctrl", &MAIN_CTRL),
      ("overwrite", &MAIN_OVERWRITE),
      ("entry", &MAIN_ENTRY),
      ("other", &MAIN_OTHER),
    ] {
      let (count, sum_ms) = metric.take();
      main_by_kind.insert(
        kind.to_owned(),
        serde_json::json!({"count": count, "sum_ms": sum_ms}),
      );
    }
    let (restore_calls, restore_background_sum_ms) = RESTORE.take();
    let restore_hits = RESTORE_HITS.swap(0, Relaxed);
    let (_, restore_get_sum_ms) = RESTORE_GET.take();
    let (_, restore_need_build_sum_ms) = NEED_BUILD.take();
    let (storage_wait_calls, storage_wait_sum_ms) = STORAGE_WAIT.take();
    let (storage_read_calls, storage_read_sum_ms) = STORAGE_READ.take();
    let (storage_decode_calls, storage_decode_sum_ms) = STORAGE_DECODE.take();
    let (_, restore_storage_wait_sum_ms) = RESTORE_STORAGE_WAIT.take();
    let (restore_storage_read_calls, restore_storage_read_sum_ms) = RESTORE_STORAGE_READ.take();
    let (restore_decode_calls, restore_decode_sum_ms) = RESTORE_DECODE.take();
    let (_, resolver_storage_wait_sum_ms) = RESOLVER_STORAGE_WAIT.take();
    let (resolver_storage_read_calls, resolver_storage_read_sum_ms) = RESOLVER_STORAGE_READ.take();
    let (resolver_decode_calls, resolver_decode_sum_ms) = RESOLVER_DECODE.take();
    let (factorize_tasks, factorize_sum_ms) = FACTORIZE.take();
    let (resolve_calls, resolve_sum_ms) = RESOLVE.take();
    let (resolve_uncached_calls, resolve_uncached_sum_ms) = RESOLVE_UNCACHED.take();
    let (json_decodes, json_decode_ms) = JSON_DECODE.take();
    let mut fields = serde_json::Map::new();
    fields.insert("pid".to_owned(), serde_json::json!(std::process::id()));
    fields.insert(
      "make_seq".to_owned(),
      serde_json::json!(MAKE_SEQ.fetch_add(1, Relaxed) + 1),
    );
    fields.insert("name".to_owned(), serde_json::json!(self.name));
    fields.insert(
      "compilation_id".to_owned(),
      serde_json::json!(self.compilation_id),
    );
    fields.insert("make_start_ns".to_owned(), serde_json::json!(self.start_ns));
    fields.insert("make_end_ns".to_owned(), serde_json::json!(end_ns));
    fields.insert("make_wall_ms".to_owned(), serde_json::json!(make_wall_ms));
    fields.insert("main_tasks".to_owned(), serde_json::json!(main_tasks));
    fields.insert("main_busy_ms".to_owned(), serde_json::json!(main_busy_ms));
    fields.insert("main_by_kind".to_owned(), serde_json::json!(main_by_kind));
    fields.insert(
      "connections_added".to_owned(),
      serde_json::json!(CONNECTIONS.swap(0, Relaxed)),
    );
    fields.insert("restore_calls".to_owned(), serde_json::json!(restore_calls));
    fields.insert("restore_hits".to_owned(), serde_json::json!(restore_hits));
    fields.insert(
      "restore_misses".to_owned(),
      serde_json::json!(restore_calls.saturating_sub(restore_hits)),
    );
    fields.insert(
      "restore_background_sum_ms".to_owned(),
      serde_json::json!(restore_background_sum_ms),
    );
    fields.insert(
      "restore_get_sum_ms".to_owned(),
      serde_json::json!(restore_get_sum_ms),
    );
    fields.insert(
      "restore_need_build_sum_ms".to_owned(),
      serde_json::json!(restore_need_build_sum_ms),
    );
    fields.insert(
      "restore_storage_wait_sum_ms".to_owned(),
      serde_json::json!(restore_storage_wait_sum_ms),
    );
    fields.insert(
      "restore_storage_read_calls".to_owned(),
      serde_json::json!(restore_storage_read_calls),
    );
    fields.insert(
      "restore_storage_read_sum_ms".to_owned(),
      serde_json::json!(restore_storage_read_sum_ms),
    );
    fields.insert(
      "restore_decode_calls".to_owned(),
      serde_json::json!(restore_decode_calls),
    );
    fields.insert(
      "restore_decode_sum_ms".to_owned(),
      serde_json::json!(restore_decode_sum_ms),
    );
    fields.insert(
      "storage_wait_calls".to_owned(),
      serde_json::json!(storage_wait_calls),
    );
    fields.insert(
      "storage_wait_sum_ms".to_owned(),
      serde_json::json!(storage_wait_sum_ms),
    );
    fields.insert(
      "storage_read_calls".to_owned(),
      serde_json::json!(storage_read_calls),
    );
    fields.insert(
      "storage_read_sum_ms".to_owned(),
      serde_json::json!(storage_read_sum_ms),
    );
    fields.insert(
      "storage_decode_calls".to_owned(),
      serde_json::json!(storage_decode_calls),
    );
    fields.insert(
      "storage_decode_sum_ms".to_owned(),
      serde_json::json!(storage_decode_sum_ms),
    );
    fields.insert(
      "resolver_storage_wait_sum_ms".to_owned(),
      serde_json::json!(resolver_storage_wait_sum_ms),
    );
    fields.insert(
      "resolver_storage_read_calls".to_owned(),
      serde_json::json!(resolver_storage_read_calls),
    );
    fields.insert(
      "resolver_storage_read_sum_ms".to_owned(),
      serde_json::json!(resolver_storage_read_sum_ms),
    );
    fields.insert(
      "resolver_decode_calls".to_owned(),
      serde_json::json!(resolver_decode_calls),
    );
    fields.insert(
      "resolver_decode_sum_ms".to_owned(),
      serde_json::json!(resolver_decode_sum_ms),
    );
    fields.insert(
      "factorize_tasks".to_owned(),
      serde_json::json!(factorize_tasks),
    );
    fields.insert(
      "factorize_sum_ms".to_owned(),
      serde_json::json!(factorize_sum_ms),
    );
    fields.insert("resolve_calls".to_owned(), serde_json::json!(resolve_calls));
    fields.insert(
      "resolve_sum_ms".to_owned(),
      serde_json::json!(resolve_sum_ms),
    );
    fields.insert(
      "resolve_uncached_calls".to_owned(),
      serde_json::json!(resolve_uncached_calls),
    );
    fields.insert(
      "resolve_uncached_sum_ms".to_owned(),
      serde_json::json!(resolve_uncached_sum_ms),
    );
    fields.insert("json_decodes".to_owned(), serde_json::json!(json_decodes));
    fields.insert(
      "json_bytes".to_owned(),
      serde_json::json!(JSON_BYTES.swap(0, Relaxed)),
    );
    fields.insert(
      "json_decode_ms".to_owned(),
      serde_json::json!(json_decode_ms),
    );
    fields.insert(
      "resolver_cache_gets".to_owned(),
      serde_json::json!(RESOLVER_GETS.swap(0, Relaxed)),
    );
    fields.insert(
      "resolver_cache_hits".to_owned(),
      serde_json::json!(RESOLVER_HITS.swap(0, Relaxed)),
    );
    fields.insert(
      "resolver_cache_sets".to_owned(),
      serde_json::json!(RESOLVER_SETS.swap(0, Relaxed)),
    );
    fields.insert(
      "resolver_cache_entries_at_ready".to_owned(),
      serde_json::json!(RESOLVER_READY_ENTRIES.swap(0, Relaxed)),
    );
    fields.insert(
      "resolver_cache_decoded_entries".to_owned(),
      serde_json::json!(RESOLVER_DECODED_ENTRIES.swap(0, Relaxed)),
    );
    fields.insert(
      "resolver_cache_decoded_bytes".to_owned(),
      serde_json::json!(RESOLVER_DECODED_BYTES.swap(0, Relaxed)),
    );
    let line = serde_json::Value::Object(fields);
    let path = output().as_ref().expect("make timers enabled");
    let result = serde_json::to_vec(&line)
      .map_err(std::io::Error::other)
      .and_then(|mut buffer| {
        buffer.push(b'\n');
        let _guard = WRITE_LOCK
          .lock()
          .unwrap_or_else(std::sync::PoisonError::into_inner);
        OpenOptions::new()
          .create(true)
          .append(true)
          .open(path)
          .and_then(|mut file| file.write_all(&buffer))
      });
    if let Err(error) = result {
      eprintln!("Failed to write make timers: {error}");
    }
  }
}
