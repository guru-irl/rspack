//! Opt-in watcher diagnostics. No paths or dependency names are printed.
use std::{
  cell::Cell,
  fmt,
  fs::OpenOptions,
  io::{self, Write},
  sync::{
    OnceLock,
    atomic::{AtomicU64, Ordering},
    mpsc::{SyncSender, sync_channel},
  },
  time::{Instant, SystemTime, UNIX_EPOCH},
};

const QUEUE_CAPACITY: usize = 256;
static ENABLED: OnceLock<bool> = OnceLock::new();
static ORIGIN: OnceLock<Instant> = OnceLock::new();
static WRITER: OnceLock<Option<SyncSender<String>>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);
thread_local! {
  static IGNORED: Cell<(u64, u64)> = const { Cell::new((0, 0)) };
}

fn write_line(output: &mut dyn Write, mut bytes: &[u8]) -> io::Result<()> {
  while !bytes.is_empty() {
    match output.write(bytes) {
      Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
      Ok(written) => bytes = &bytes[written..],
      Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
      Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
        std::thread::sleep(std::time::Duration::from_millis(1));
      }
      Err(error) => return Err(error),
    }
  }
  Ok(())
}

// Only this detached thread touches the output. A blocked or broken sink must
// not delay watcher delivery, including during process shutdown.
fn writer() -> Option<SyncSender<String>> {
  let (sender, receiver) = sync_channel::<String>(QUEUE_CAPACITY);
  let file = std::env::var_os("RSPACK_NATIVE_WATCHER_TIMING_FILE");
  std::thread::Builder::new()
    .name("rspack-timing".to_owned())
    .spawn(move || {
      let mut output: Box<dyn Write> = match file {
        Some(path) => match OpenOptions::new().create(true).append(true).open(path) {
          Ok(file) => Box::new(file),
          Err(_) => Box::new(io::sink()),
        },
        None => Box::new(io::stderr()),
      };
      while let Ok(line) = receiver.recv() {
        if write_line(&mut *output, line.as_bytes()).is_err() {
          DROPPED.fetch_add(1, Ordering::Relaxed);
        }
        let dropped = DROPPED.swap(0, Ordering::Relaxed);
        if dropped != 0 {
          let report = format!(
            "[rspack-watcher-timing] t={:.3} pid={} watcher=0 phase=dropped count={dropped}\n",
            timestamp(Instant::now()),
            std::process::id()
          );
          if write_line(&mut *output, report.as_bytes()).is_err() {
            // Keep the unreported losses, and count the failed report too.
            DROPPED.fetch_add(dropped.wrapping_add(1), Ordering::Relaxed);
          }
        }
      }
    })
    .ok()?;
  Some(sender)
}

fn enqueue(line: String) {
  if let Some(Some(sender)) = WRITER.get()
    && sender.try_send(line).is_err()
  {
    DROPPED.fetch_add(1, Ordering::Relaxed);
  }
}

#[inline]
pub(crate) fn enabled() -> bool {
  *ENABLED.get_or_init(|| {
    let enabled = std::env::var_os("RSPACK_NATIVE_WATCHER_TIMING").is_some_and(|v| v == "1");
    if enabled {
      let _ = ORIGIN.set(Instant::now());
      let _ = WRITER.set(writer());
      let unix_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
      enqueue(format!("[rspack-watcher-timing] t=0.000 pid={} watcher=0 phase=clock unix_ms={unix_ms} origin=first-timer\n", std::process::id()));
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
  ORIGIN
    .get()
    .map_or(0.0, |origin| ms(instant.saturating_duration_since(*origin)))
}

pub(crate) fn emit(watcher: usize, fields: fmt::Arguments<'_>) {
  if enabled() {
    enqueue(format!(
      "[rspack-watcher-timing] t={:.3} pid={} watcher={watcher:x} {fields}\n",
      timestamp(Instant::now()),
      std::process::id()
    ));
  }
}

#[inline]
pub(crate) fn ignored(is_js: bool) {
  if enabled() {
    let _ = IGNORED.try_with(|count| {
      let (all, js) = count.get();
      count.set((all.wrapping_add(1), js.wrapping_add(u64::from(is_js))));
    });
  }
}

pub(crate) fn ignored_counts() -> (u64, u64) {
  IGNORED.try_with(Cell::get).unwrap_or_default()
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
      .map(|receipt| ms(now.saturating_duration_since(receipt)))
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
        ignored.0.wrapping_sub(self.ignored.0),
        ignored.1.wrapping_sub(self.ignored.1),
        latencies.len(),
        self.first_dispatch_index.map_or(-1, |v| v as i64),
        latencies.last().copied().unwrap_or_default(),
        ms(now.saturating_duration_since(self.start))
      ),
    );
  }

  pub(crate) fn classification_ms(&self) -> f64 {
    ms(self.start.elapsed())
  }
}
