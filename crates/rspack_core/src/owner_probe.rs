//! Measurement-only owner probe. SIGUSR2 is destructive and must be the last action before teardown.
use std::{
  fs::{File, OpenOptions},
  io::Write,
  sync::{
    Arc, Mutex, OnceLock, Weak,
    atomic::{AtomicU64, Ordering::Relaxed},
  },
  time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::{Compilation, CompilerCache, FileSystemInfo, ResolverCache};

pub(crate) const USERS: [&str; 8] = [
  "resolver",
  "loader",
  "code_generation",
  "runtime_requirements",
  "js_render",
  "css_render",
  "extract_css_render",
  "other",
];
static ENABLED: OnceLock<bool> = OnceLock::new();
pub(crate) fn enabled() -> bool {
  *ENABLED.get_or_init(|| std::env::var_os("RSPACK_OWNER_PROBE_LOG").is_some())
}
pub(crate) fn user(key: &str) -> usize {
  // Exact namespace components only. Never classify from resource paths.
  for part in key.split('|') {
    match part {
      "ResolverCache" => return 0,
      "loader" => return 1,
      "Compilation/codeGeneration" => return 2,
      _ => {}
    }
  }
  // This base keeps runtime requirements and render values in incremental artifacts.
  7
}
#[derive(Debug)]
pub(crate) struct Counters {
  values: [[AtomicU64; 5]; 8],
}
impl Default for Counters {
  fn default() -> Self {
    Self {
      values: std::array::from_fn(|_| std::array::from_fn(|_| AtomicU64::new(0))),
    }
  }
}
impl Counters {
  pub(crate) fn record(&self, key: &crate::new_cache::CacheKey, outcome: usize) {
    self.values[user(key.as_str())][outcome].fetch_add(1, Relaxed);
  }
  fn reset(&self) {
    for v in self.values.iter().flatten() {
      v.store(0, Relaxed);
    }
  }
  fn snapshot(&self) -> [[u64; 5]; 8] {
    std::array::from_fn(|u| std::array::from_fn(|o| self.values[u][o].load(Relaxed)))
  }
}
struct Runtime {
  file: Mutex<File>,
  compilers: Mutex<Vec<Weak<CompilerProbe>>>,
}
static RUNTIME: OnceLock<Arc<Runtime>> = OnceLock::new();
fn runtime() -> Option<&'static Arc<Runtime>> {
  if !enabled() {
    return None;
  }
  Some(RUNTIME.get_or_init(|| {
  let file = OpenOptions::new().create(true).append(true).open(std::env::var_os("RSPACK_OWNER_PROBE_LOG").expect("probe path")).expect("open owner probe log");
  let runtime = Arc::new(Runtime { file: Mutex::new(file), compilers: Mutex::new(Vec::new()) });
  let mut signals = signal_hook::iterator::Signals::new([signal_hook::consts::SIGUSR2]).expect("owner probe signal");
  let r = runtime.clone();
  std::thread::Builder::new().name("owner-probe".into()).stack_size(256*1024).spawn(move || {
   for _ in signals.forever() {
    let start = Instant::now();
    let pre = rspack_allocator::measurement_live_bytes();
    let compilers: Vec<_> = r.compilers.lock().expect("probe compilers").iter().filter_map(Weak::upgrade).collect();
    r.write(json!({"event":"end_start", "epoch_ms":epoch_ms(), "live_bytes":pre, "compilers":compilers.len()}));
    for c in &compilers { c.end(); }
    r.write(json!({"event":"end_complete", "epoch_ms":epoch_ms(), "live_bytes":rspack_allocator::measurement_live_bytes(), "elapsed_us":start.elapsed().as_micros()}));
   }
  }).expect("owner probe thread");
  runtime
 }))
}
impl Runtime {
  fn write(&self, value: Value) {
    let mut f = self.file.lock().expect("probe file");
    if let Err(e) = serde_json::to_writer(&mut *f, &value)
      .and_then(|_| f.write_all(b"\n").map_err(serde_json::Error::io))
    {
      eprintln!("owner probe write failed: {e}");
    }
  }
}
fn epoch_ms() -> u128 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_or(0, |d| d.as_millis())
}
fn rss_anon() -> usize {
  std::fs::read_to_string("/proc/self/status")
    .ok()
    .and_then(|s| {
      s.lines()
        .find(|l| l.starts_with("RssAnon:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse::<usize>().ok())
    })
    .unwrap_or(0)
    * 1024
}
#[derive(Debug)]
struct Completed {
  graph: [usize; 6],
  fsi: FileSystemInfo,
  resolver: Option<ResolverCache>,
}
#[derive(Debug)]
pub(crate) struct CompilerProbe {
  id: u32,
  name: String,
  prefix: Arc<str>,
  cache: CompilerCache,
  new_cache: bool,
  build: AtomicU64,
  counters: Arc<Counters>,
  completed: Mutex<Option<Completed>>,
}
pub(crate) fn register(
  id: u32,
  name: &str,
  prefix: Arc<str>,
  cache: CompilerCache,
  new_cache: bool,
) -> Option<Arc<CompilerProbe>> {
  let r = runtime()?;
  let counters = cache.owner_probe_register(prefix.clone());
  let probe = Arc::new(CompilerProbe {
    id,
    name: name.into(),
    prefix,
    cache,
    new_cache,
    build: AtomicU64::new(0),
    counters,
    completed: Mutex::new(None),
  });
  let mut cs = r.compilers.lock().expect("probe compilers");
  cs.retain(|c| c.strong_count() > 0);
  cs.push(Arc::downgrade(&probe));
  Some(probe)
}
impl CompilerProbe {
  pub(crate) fn start(&self) {
    self.completed.lock().expect("probe completed").take();
    self.counters.reset();
    self.build.fetch_add(1, Relaxed);
  }
  pub(crate) fn done(&self, compilation: &Compilation) {
    let start = Instant::now();
    let g = compilation.get_module_graph().owner_probe_counts();
    *self.completed.lock().expect("probe completed") = Some(Completed {
      graph: [
        g[0],
        g[1],
        g[2],
        g[3],
        compilation.build_chunk_graph_artifact.chunk_by_ukey.len(),
        compilation.code_generation_results.inner().len(),
      ],
      fsi: compilation.file_system_info.clone(),
      resolver: compilation.resolver_cache.clone(),
    });
    self.snapshot("build_done", false);
    // Logging is always collected by CompilationLogger, independent of JS stats/log settings.
    for entry in compilation.get_logging().iter() {
      if entry.key().starts_with("rspack.incremental.") {
        for log in entry.value() {
          self.write(json!({"event":"incremental_log", "logger":entry.key().as_ref(),"text":format!("{log:?}")}));
        }
      }
    }
    self.write(json!({"event":"snapshot_cost", "elapsed_us":start.elapsed().as_micros()}));
  }
  fn write(&self, mut v: Value) {
    if let Some(m) = v.as_object_mut() {
      m.insert("compiler".into(), json!(self.name));
      m.insert("compiler_id".into(), json!(self.id));
      m.insert("build_index".into(), json!(self.build.load(Relaxed)));
      m.insert("epoch_ms".into(), json!(epoch_ms()));
    }
    RUNTIME.get().expect("probe runtime").write(v);
  }
  fn snapshot(&self, event: &str, full: bool) {
    let start = Instant::now();
    let before = rspack_allocator::measurement_live_bytes();
    let c = self.completed.lock().expect("probe completed");
    let mut value = json!({"event":event,"live_bytes":rspack_allocator::measurement_live_bytes(),"rss_anon_bytes":rss_anon(), "new_cache":self.new_cache,
    "cache":self.new_cache.then(||self.cache.owner_probe_snapshot(full,&self.prefix)),
    "graph":c.as_ref().map(|c|c.graph), "filesystem_info":c.as_ref().map(|c|c.fsi.owner_probe_counts()), "resolver_locks":c.as_ref().and_then(|c| c.resolver.as_ref()).map(|r|r.owner_probe_locks(false)),
    "json_interner":rspack_cacheable::with::AsSharedJson::owner_probe_counts(full),"cache_counters":self.counters.snapshot()});
    let constructed = rspack_allocator::measurement_live_bytes();
    value["probe_transient_live_bytes"] = json!(constructed - before);
    value["probe_construct_us"] = json!(start.elapsed().as_micros());
    self.write(value);
  }
  fn delta(&self, owner: &str, drop: impl FnOnce()) {
    let start = Instant::now();
    let before = rspack_allocator::measurement_live_bytes();
    drop();
    let after = rspack_allocator::measurement_live_bytes();
    self.write(json!({"event":"drop","owner":owner,"before_bytes":before,"after_bytes":after,"delta_bytes":before-after,"elapsed_us":start.elapsed().as_micros()}));
  }
  fn end(&self) {
    if self.completed.lock().expect("probe completed").is_none() {
      self.write(
        json!({"event":"end_skipped","reason":"compiler is building or has no completed build"}),
      );
      return;
    }
    self.snapshot("end_snapshot", true);
    if self.new_cache {
      for (u, name) in USERS.iter().enumerate() {
        self.delta(name, || self.cache.owner_probe_drop_user(&self.prefix, u));
      }
      self.delta("turbo_block_caches", || {
        self.cache.owner_probe_drop_blocks()
      });
      self.delta("filesystem_info", || {
        self.cache.owner_probe_drop_fsi();
        if let Some(c) = self.completed.lock().expect("probe completed").as_ref() {
          c.fsi.owner_probe_clear();
        }
      });
      self.delta("resolver_locks", || {
        if let Some(c) = self.completed.lock().expect("probe completed").as_ref() {
          if let Some(r) = &c.resolver {
            r.owner_probe_locks(true);
          }
        }
      });
    }
    self.snapshot("end_remainder", true);
  }
}
