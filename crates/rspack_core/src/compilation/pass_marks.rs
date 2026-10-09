use std::{
  cell::RefCell,
  path::{Path, PathBuf},
  sync::LazyLock,
};

use crate::Compilation;

static OUTPUT: LazyLock<Option<PathBuf>> = LazyLock::new(|| {
  std::env::var_os("RSPACK_RAYON_MARKS")
    .filter(|path| !path.is_empty())
    .map(PathBuf::from)
});

pub(super) struct PassMarks {
  output: &'static Path,
  compiler: String,
  compiler_id: u32,
  compilation_id: u32,
  before: RefCell<Option<serde_json::Value>>,
}

impl PassMarks {
  pub(super) fn new(compilation: &Compilation) -> Option<Self> {
    let output = OUTPUT.as_deref()?;
    if !cfg!(any(target_os = "linux", target_os = "macos")) {
      return None;
    }
    let compiler_id = compilation.compiler_id().as_u32();
    Some(Self {
      output,
      compiler: compilation
        .options
        .name
        .clone()
        .unwrap_or_else(|| format!("compiler-{compiler_id}")),
      compiler_id,
      compilation_id: compilation.id().0,
      before: RefCell::new(None),
    })
  }

  pub(super) fn mark(&self, pass: &str, event: &str) {
    let counters = snapshot();
    let delta = if event == "end" {
      self.before.borrow_mut().take().map(|before| {
        let mut delta = serde_json::Map::new();
        for (key, value) in counters.as_object().expect("snapshot is an object") {
          if key == "tokio_global_queue_depth" {
            continue;
          }
          delta.insert(
            key.clone(),
            serde_json::json!(
              value
                .as_u64()
                .expect("counter")
                .saturating_sub(before[key].as_u64().expect("counter"))
            ),
          );
        }
        serde_json::Value::Object(delta)
      })
    } else {
      self.before.replace(Some(counters.clone()));
      None
    };
    let line = serde_json::json!({
      "pid": std::process::id(),
      "timestamp_ns": counters["wall_ns"].as_u64().expect("clock").to_string(),
      "counters": counters,
      "delta": delta,
      "compiler": self.compiler,
      "compiler_id": format!("rust:{}", self.compiler_id),
      "compilation_id": self.compilation_id,
      "build": self.compilation_id,
      "source": "rust",
      "pass": pass,
      "event": event,
      "hook": format!("{pass}:{event}"),
    });
    if rspack_parallel::scope::append_mark_record(self.output, &line).is_err() {
      eprintln!("Rayon pass mark could not be written");
    }
  }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn now_ns() -> u64 {
  use std::os::raw::{c_int, c_long};
  #[repr(C)]
  struct Timespec {
    sec: c_long,
    nsec: c_long,
  }
  unsafe extern "C" {
    fn clock_gettime(clock: c_int, value: *mut Timespec) -> c_int;
  }
  #[cfg(target_os = "linux")]
  const CLOCK: c_int = 1;
  #[cfg(target_os = "macos")]
  const CLOCK: c_int = 4;
  let mut t = Timespec { sec: 0, nsec: 0 };
  let result = unsafe { clock_gettime(CLOCK, &mut t) };
  assert_eq!(result, 0, "measurement clock unavailable");
  t.sec as u64 * 1_000_000_000 + t.nsec as u64
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn now_ns() -> u64 {
  0
}

fn snapshot() -> serde_json::Value {
  let metrics = tokio::runtime::Handle::current().metrics();
  let workers = metrics.num_workers();
  let sum = |read: fn(&tokio::runtime::RuntimeMetrics, usize) -> u64| {
    (0..workers)
      .map(|worker| read(&metrics, worker))
      .sum::<u64>()
  };
  let (user, system, voluntary, involuntary) = process_usage();
  serde_json::json!({
    "wall_ns": now_ns(),
    "user_cpu_ns": user,
    "system_cpu_ns": system,
    "voluntary_context_switches": voluntary,
    "involuntary_context_switches": involuntary,
    "rspack_spawned_tasks": rspack_tasks::spawned_tasks_count(),
    "tokio_worker_parks": sum(tokio::runtime::RuntimeMetrics::worker_park_count),
    "tokio_worker_park_unparks": sum(tokio::runtime::RuntimeMetrics::worker_park_unpark_count),
    "tokio_worker_busy_ns": (0..workers).map(|worker| metrics.worker_total_busy_duration(worker).as_nanos() as u64).sum::<u64>(),
    "tokio_global_queue_depth": metrics.global_queue_depth(),
  })
}

#[cfg(unix)]
fn process_usage() -> (u64, u64, u64, u64) {
  let mut usage = unsafe { std::mem::zeroed::<libc::rusage>() };
  assert_eq!(
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) },
    0,
    "process usage unavailable"
  );
  let ns = |t: libc::timeval| t.tv_sec as u64 * 1_000_000_000 + t.tv_usec as u64 * 1_000;
  (
    ns(usage.ru_utime),
    ns(usage.ru_stime),
    usage.ru_nvcsw as u64,
    usage.ru_nivcsw as u64,
  )
}
#[cfg(not(unix))]
fn process_usage() -> (u64, u64, u64, u64) {
  (0, 0, 0, 0)
}
