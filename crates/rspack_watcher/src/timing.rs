//! Opt-in watcher diagnostics. No paths or dependency names are printed.
use std::{
  cell::Cell,
  fmt,
  sync::OnceLock,
  time::{Instant, SystemTime, UNIX_EPOCH},
};

static ENABLED: OnceLock<bool> = OnceLock::new();
static ORIGIN: OnceLock<Instant> = OnceLock::new();
thread_local! {
  static IGNORED: Cell<(u64, u64)> = const { Cell::new((0, 0)) };
}

#[inline]
pub(crate) fn enabled() -> bool {
  *ENABLED.get_or_init(|| {
    let enabled = std::env::var_os("RSPACK_NATIVE_WATCHER_TIMING").is_some_and(|v| v == "1");
    if enabled {
      let origin = Instant::now();
      let unix_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
      let _ = ORIGIN.set(origin);
      eprintln!("[rspack-watcher-timing] t=0.000 pid={} watcher=0 phase=clock unix_ms={unix_ms} origin=first-timer", std::process::id());
    }
    enabled
  })
}

#[inline]
pub(crate) fn start() -> Option<Instant> {
  if enabled() {
    Some(Instant::now())
  } else {
    None
  }
}

pub(crate) fn ms(duration: std::time::Duration) -> f64 {
  duration.as_secs_f64() * 1000.0
}

pub(crate) fn timestamp(instant: Instant) -> f64 {
  ms(instant.saturating_duration_since(*ORIGIN.get().expect("timing origin")))
}

pub(crate) fn emit(watcher: usize, fields: fmt::Arguments<'_>) {
  eprintln!(
    "[rspack-watcher-timing] t={:.3} pid={} watcher={watcher:x} {fields}",
    timestamp(Instant::now()),
    std::process::id()
  );
}

#[inline]
pub(crate) fn ignored(is_js: bool) {
  if enabled() {
    IGNORED.with(|count| {
      let (all, js) = count.get();
      count.set((all + 1, js + u64::from(is_js)));
    });
  }
}

pub(crate) fn ignored_counts() -> (u64, u64) {
  IGNORED.with(Cell::get)
}

pub(crate) struct Batch {
  start: Instant,
  ignored: (u64, u64),
  receipts: Vec<Instant>,
  size: usize,
  first_dispatch_index: Option<usize>,
}

impl Batch {
  pub(crate) fn start(size: usize) -> Option<Self> {
    start().map(|start| Self {
      start,
      ignored: ignored_counts(),
      receipts: Vec::new(),
      size,
      first_dispatch_index: None,
    })
  }

  pub(crate) fn dispatched(&mut self, receipt: Option<Instant>, index: usize) {
    if let Some(receipt) = receipt {
      self.receipts.push(receipt);
      self.first_dispatch_index.get_or_insert(index);
    }
  }

  pub(crate) fn finish(self, watcher: usize, classification_ms: f64) {
    let now = Instant::now();
    let mut latencies: Vec<_> = self
      .receipts
      .into_iter()
      .map(|receipt| ms(now.duration_since(receipt)))
      .collect();
    latencies.sort_by(f64::total_cmp);
    let median = if latencies.is_empty() {
      0.0
    } else {
      (latencies[(latencies.len() - 1) / 2] + latencies[latencies.len() / 2]) / 2.0
    };
    let ignored = ignored_counts();
    emit(
      watcher,
      format_args!(
        "phase=trigger size={} classification_ms={classification_ms:.3} ignored_awaits={} js_ignored_awaits={} dispatched={} first_dispatch_index={} receipt_to_dispatch_median_ms={median:.3} receipt_to_dispatch_max_ms={:.3} duration_ms={:.3}",
        self.size,
        ignored.0 - self.ignored.0,
        ignored.1 - self.ignored.1,
        latencies.len(),
        self.first_dispatch_index.map_or(-1, |v| v as i64),
        latencies.last().copied().unwrap_or_default(),
        ms(now.duration_since(self.start))
      ),
    );
  }

  pub(crate) fn classification_ms(&self) -> f64 {
    ms(self.start.elapsed())
  }
}
