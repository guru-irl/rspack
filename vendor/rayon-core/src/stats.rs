//! Opt-in, process-global slow-path measurements. Not a scheduling policy.
use std::{
  fs::OpenOptions,
  io::Write,
  path::PathBuf,
  sync::{
    Mutex, OnceLock,
    atomic::{
      AtomicBool, AtomicU64,
      Ordering::{Acquire, Relaxed, Release},
    },
  },
  time::Duration,
};

// Separate even on machines with 128-byte cache lines.
#[repr(align(128))]
pub(crate) struct Counter(AtomicU64);
impl Counter {
  const fn new() -> Self {
    Self(AtomicU64::new(0))
  }
  pub(crate) fn add(&self, n: u64) {
    self.0.fetch_add(n, Relaxed);
  }
  fn get(&self) -> u64 {
    self.0.load(Relaxed)
  }
}
pub(crate) static COLD_OPS: Counter = Counter::new();
static COLD_NS: Counter = Counter::new();
pub(crate) static CROSS_OPS: Counter = Counter::new();
pub(crate) static INJECTED: Counter = Counter::new();
pub(crate) static WAKES: Counter = Counter::new();
pub(crate) static SLEEPS: Counter = Counter::new();
static HIST: [Counter; 7] = [const { Counter::new() }; 7];
static ENABLED: OnceLock<bool> = OnceLock::new();
static OUTPUT: OnceLock<PathBuf> = OnceLock::new();
static OUTPUT_MUTEX: Mutex<()> = Mutex::new(());
static STOP: AtomicBool = AtomicBool::new(false);
const HEADER: &str = "timestamp_ns,pid,cold_ops,cold_ns,cross_ops,injected,wakes,sleeps,hist_0_10_us,hist_10_30_us,hist_30_100_us,hist_100_300_us,hist_300_1000_us,hist_1000_3000_us,hist_3000_inf_us,user_cpu_ns,system_cpu_ns,voluntary_context_switches,minor_faults,major_faults\n";

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn now_ns() -> u64 {
  use std::os::raw::{c_int, c_long};
  #[repr(C)]
  struct Timespec {
    sec: c_long,
    nsec: c_long,
  }
  extern "C" {
    fn clock_gettime(clock: c_int, value: *mut Timespec) -> c_int;
  }
  #[cfg(target_os = "linux")]
  const CLOCK: c_int = 1; // CLOCK_MONOTONIC, also used by libuv hrtime.
  #[cfg(target_os = "macos")]
  const CLOCK: c_int = 4; // CLOCK_MONOTONIC_RAW, matching current libuv hrtime including sleep.
  let mut t = Timespec { sec: 0, nsec: 0 };
  let rc = unsafe { clock_gettime(CLOCK, &mut t) };
  assert_eq!(rc, 0, "measurement clock unavailable");
  t.sec as u64 * 1_000_000_000 + t.nsec as u64
}

// Sampling is deliberately unsupported on other platforms. Counters still work.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn now_ns() -> u64 {
  0
}

#[cfg(unix)]
fn process_usage() -> (u64, u64, u64, u64, u64) {
  let mut usage = unsafe { std::mem::zeroed::<libc::rusage>() };
  if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
    return (0, 0, 0, 0, 0);
  }
  #[cfg(target_os = "linux")]
  let cpu = {
    static TICKS: OnceLock<u64> = OnceLock::new();
    let ticks = *TICKS.get_or_init(|| unsafe { libc::sysconf(libc::_SC_CLK_TCK) as u64 });
    std::fs::read_to_string("/proc/self/stat")
      .ok()
      .and_then(|text| {
        let (_, rest) = text.rsplit_once(')')?;
        let fields: Vec<_> = rest.split_whitespace().collect();
        let user = fields.get(11)?.parse::<u64>().ok()?;
        let system = fields.get(12)?.parse::<u64>().ok()?;
        let minor = fields.get(7)?.parse::<u64>().ok()?;
        let major = fields.get(9)?.parse::<u64>().ok()?;
        Some((
          user * 1_000_000_000 / ticks,
          system * 1_000_000_000 / ticks,
          minor,
          major,
        ))
      })
      .unwrap_or((0, 0, 0, 0))
  };
  #[cfg(not(target_os = "linux"))]
  let cpu = (
    usage.ru_utime.tv_sec as u64 * 1_000_000_000 + usage.ru_utime.tv_usec as u64 * 1_000,
    usage.ru_stime.tv_sec as u64 * 1_000_000_000 + usage.ru_stime.tv_usec as u64 * 1_000,
    usage.ru_minflt as u64,
    usage.ru_majflt as u64,
  );
  (cpu.0, cpu.1, usage.ru_nvcsw as u64, cpu.2, cpu.3)
}
#[cfg(not(unix))]
fn process_usage() -> (u64, u64, u64, u64, u64) {
  (0, 0, 0, 0, 0)
}

fn sample(final_sample: bool) {
  if let Some(path) = OUTPUT.get() {
    let usage = process_usage();
    let line = format!(
      "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
      now_ns(),
      std::process::id(),
      COLD_OPS.get(),
      COLD_NS.get(),
      CROSS_OPS.get(),
      INJECTED.get(),
      WAKES.get(),
      SLEEPS.get(),
      HIST[0].get(),
      HIST[1].get(),
      HIST[2].get(),
      HIST[3].get(),
      HIST[4].get(),
      HIST[5].get(),
      HIST[6].get(),
      usage.0,
      usage.1,
      usage.2,
      usage.3,
      usage.4
    );
    if let Ok(_guard) = OUTPUT_MUTEX.lock() {
      if STOP.load(Acquire) && !final_sample {
        return;
      }
      if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let mut bytes = Vec::with_capacity(HEADER.len() + line.len());
        if file.metadata().map(|m| m.len() == 0).unwrap_or(false) {
          bytes.extend_from_slice(HEADER.as_bytes());
        }
        bytes.extend_from_slice(line.as_bytes());
        let _ = file.write_all(&bytes);
      }
    }
  }
}

extern "C" fn final_sample() {
  STOP.store(true, Release);
  sample(true);
}

// Invoked on outside injection/cold entry only, never on internal join/push.
pub(crate) fn enabled() -> bool {
  *ENABLED.get_or_init(|| {
    if !cfg!(any(target_os = "linux", target_os = "macos")) {
      return false;
    }
    let Some(path) = std::env::var_os("RSPACK_RAYON_STATS") else {
      return false;
    };
    if path.is_empty() {
      return false;
    }
    let path = match path.to_str() {
      Some(path) => PathBuf::from(path.replace("{pid}", &std::process::id().to_string())),
      None => PathBuf::from(path),
    };
    if OpenOptions::new()
      .create(true)
      .append(true)
      .open(&path)
      .is_err()
    {
      eprintln!("Rayon measurement output could not be opened");
      return false;
    }
    let interval = std::env::var("RSPACK_RAYON_STATS_INTERVAL_MS")
      .ok()
      .and_then(|s| s.parse::<u64>().ok())
      .filter(|n| *n > 0)
      .unwrap_or(5);
    let _ = OUTPUT.set(path);
    sample(false);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    unsafe {
      extern "C" {
        fn atexit(callback: extern "C" fn()) -> std::os::raw::c_int;
      }
      let _ = atexit(final_sample);
    }
    if std::thread::Builder::new()
      .name("rayon-stats".into())
      .spawn(move || {
        while !STOP.load(Acquire) {
          std::thread::sleep(Duration::from_millis(interval));
          sample(false);
        }
      })
      .is_err()
    {
      eprintln!("Rayon measurement sampler could not be started");
      return false;
    }
    true
  })
}

pub(crate) fn cold_start() -> Option<u64> {
  let on = enabled();
  COLD_OPS.add(1);
  on.then(now_ns)
}

pub(crate) fn cold_finish(start: Option<u64>) {
  if let Some(start) = start {
    let elapsed = now_ns().saturating_sub(start);
    COLD_NS.add(elapsed);
    let bucket = [10_000, 30_000, 100_000, 300_000, 1_000_000, 3_000_000]
      .iter()
      .position(|&end| elapsed < end)
      .unwrap_or(6);
    HIST[bucket].add(1);
  }
}
