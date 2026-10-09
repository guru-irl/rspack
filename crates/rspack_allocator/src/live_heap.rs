//! Measurement only, never for upstream.
//!
//! Counts the bytes currently allocated through Rust's global allocator. When
//! `RSPACK_LIVE_HEAP_LOG` names a file, counting is active from the first
//! allocation, and a sampler thread (started with the first compiler) appends
//! one tab-separated line per interval:
//! `epoch_ms  elapsed_ms  pid  live_bytes  peak_bytes`.
//! Lines are written straight to the file, so a killed process keeps every
//! sample. `RSPACK_LIVE_HEAP_INTERVAL_MS` overrides the 1000 ms interval.
//! Without the variable, each allocation and free pays one relaxed atomic load.
//!
//! Diagnostic exact counter: every nonzero delta updates the shared counter.
//! This can perturb scheduling. Compare counter builds with counter builds;
//! these instrumented timings are not performance acceptance measurements.
//!
//! Counted bytes are the sizes Rust requests. They exclude V8's heap, other
//! native libraries, and the allocator's own overhead and free pages.

use std::{
  alloc::{GlobalAlloc, Layout},
  cell::Cell,
  ffi::c_char,
  io::Write,
  sync::{
    Once,
    atomic::{AtomicIsize, AtomicU8, Ordering::Relaxed},
  },
  time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const LOG_VAR: &str = "RSPACK_LIVE_HEAP_LOG";
const LOG_VAR_C: &[u8] = b"RSPACK_LIVE_HEAP_LOG\0";
const INTERVAL_VAR: &str = "RSPACK_LIVE_HEAP_INTERVAL_MS";
// Exact requested-byte counter: flush every nonzero allocation/free delta.
const FLUSH_BYTES: isize = 1;

const UNKNOWN: u8 = 0;
const OFF: u8 = 1;
const ON: u8 = 2;

static STATE: AtomicU8 = AtomicU8::new(UNKNOWN);
// Signed: a free can reach the shared counter before its allocation does.
static LIVE: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);
static SAMPLER: Once = Once::new();

thread_local! {
  // Const-initialized and without Drop, so using it never allocates.
  static PENDING: Cell<isize> = const { Cell::new(0) };
}

unsafe extern "C" {
  fn getenv(name: *const c_char) -> *const c_char;
}

#[inline]
fn counting() -> bool {
  match STATE.load(Relaxed) {
    ON => true,
    OFF => false,
    _ => {
      // Decided on the first allocation, so every later free has a counted
      // allocation. getenv doesn't allocate, which matters inside the allocator.
      let on = !unsafe { getenv(LOG_VAR_C.as_ptr().cast()) }.is_null();
      STATE.store(if on { ON } else { OFF }, Relaxed);
      on
    }
  }
}

#[inline]
fn record(delta: isize) {
  let flush = PENDING.try_with(|pending| {
    let total = pending.get() + delta;
    if total.abs() >= FLUSH_BYTES {
      pending.set(0);
      total
    } else {
      pending.set(total);
      0
    }
  });
  // Without thread-local storage (a thread shutting down), count directly.
  let flush = flush.unwrap_or(delta);
  if flush != 0 {
    let live = LIVE.fetch_add(flush, Relaxed) + flush;
    if live > PEAK.load(Relaxed) {
      PEAK.fetch_max(live, Relaxed);
    }
  }
}

pub struct LiveHeap;

unsafe impl GlobalAlloc for LiveHeap {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    let ptr = unsafe { mimalloc::MiMalloc.alloc(layout) };
    if !ptr.is_null() && counting() {
      record(layout.size() as isize);
    }
    ptr
  }

  unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
    let ptr = unsafe { mimalloc::MiMalloc.alloc_zeroed(layout) };
    if !ptr.is_null() && counting() {
      record(layout.size() as isize);
    }
    ptr
  }

  unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
    if counting() {
      record(-(layout.size() as isize));
    }
    unsafe { mimalloc::MiMalloc.dealloc(ptr, layout) }
  }

  unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
    let new_ptr = unsafe { mimalloc::MiMalloc.realloc(ptr, layout, new_size) };
    if !new_ptr.is_null() && counting() {
      record(new_size as isize - layout.size() as isize);
    }
    new_ptr
  }
}

/// Starts the sampler thread once, if `RSPACK_LIVE_HEAP_LOG` is set.
pub fn start_sampler() {
  SAMPLER.call_once(|| {
    if !counting() {
      return;
    }
    let Some(path) = std::env::var_os(LOG_VAR) else {
      return;
    };
    let interval = std::env::var(INTERVAL_VAR)
      .ok()
      .and_then(|value| value.parse().ok())
      .unwrap_or(1000);
    let mut file = match std::fs::OpenOptions::new()
      .create(true)
      .append(true)
      .open(&path)
    {
      Ok(file) => file,
      Err(err) => {
        eprintln!("{LOG_VAR}: cannot open {}: {err}", path.to_string_lossy());
        return;
      }
    };
    let pid = std::process::id();
    let start = Instant::now();
    let spawned = std::thread::Builder::new()
      .name("live-heap-sampler".into())
      .spawn(move || {
        let _ = file.write_all(b"epoch_ms\telapsed_ms\tpid\tlive_bytes\tpeak_bytes\n");
        loop {
          let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis());
          let line = format!(
            "{epoch_ms}\t{}\t{pid}\t{}\t{}\n",
            start.elapsed().as_millis(),
            LIVE.load(Relaxed),
            PEAK.load(Relaxed),
          );
          // File writes are unbuffered, so a killed process keeps every line.
          let _ = file.write_all(line.as_bytes());
          std::thread::sleep(Duration::from_millis(interval));
        }
      });
    if let Err(err) = spawned {
      eprintln!("{LOG_VAR}: cannot start sampler: {err}");
    }
  });
}
