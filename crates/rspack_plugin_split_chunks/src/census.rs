//! Measurement-only census. Never upstream. No production algorithm changes.
use std::{sync::{Arc, Mutex, OnceLock, atomic::{AtomicU64, AtomicUsize, Ordering::Relaxed}}, time::Instant};
use serde_json::{Value, json};

fn enabled() -> bool {
  static ON: OnceLock<bool> = OnceLock::new();
  *ON.get_or_init(|| std::env::var_os("RSPACK_SC_CENSUS").is_some_and(|v| !v.is_empty()))
}
fn now() -> u64 {
  static ORIGIN: OnceLock<Instant> = OnceLock::new();
  ORIGIN.get_or_init(Instant::now).elapsed().as_nanos() as u64
}
fn usage() -> [u64; 5] {
  let mut u = unsafe { std::mem::zeroed::<libc::rusage>() };
  assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) }, 0);
  [u.ru_utime.tv_sec as u64 * 1_000_000 + u.ru_utime.tv_usec as u64,
   u.ru_stime.tv_sec as u64 * 1_000_000 + u.ru_stime.tv_usec as u64,
   u.ru_nvcsw as u64, u.ru_nivcsw as u64, u.ru_maxrss as u64]
}
struct State {
  id: u64,
  priority: AtomicUsize,
  winner: AtomicUsize,
  last_exit: AtomicU64,
  records: Mutex<Vec<Value>>,
  pending: Mutex<Vec<std::sync::mpsc::Receiver<()>>>,
  controlled: bool,
}
fn completed() -> &'static Mutex<Vec<Arc<State>>> {
 static STATES: OnceLock<Mutex<Vec<Arc<State>>>> = OnceLock::new();
 STATES.get_or_init(|| Mutex::new(Vec::new()))
}
extern "C" fn flush_at_exit() {
 let states=completed().lock().unwrap();
 for s in states.iter() { wait(s); }
 if let Some(s)=states.last() {
   record(s, json!({"kind":"process_end","at_ns":now(),"counters":rayon_core::census_snapshot(),"cpu":usage(),"pool_width":rayon::current_num_threads()}));
 }
 for s in states.iter() { flush(s); }
}
fn active() -> &'static Mutex<Option<Arc<State>>> {
  static ACTIVE: OnceLock<Mutex<Option<Arc<State>>>> = OnceLock::new();
  ACTIVE.get_or_init(|| Mutex::new(None))
}
fn state() -> Option<Arc<State>> {
  if !enabled() { return None; }
  active().lock().unwrap().clone()
}
fn record(s: &State, v: Value) {
  let mut rows = s.records.lock().unwrap();
  assert!(rows.len() < 250_000, "census record cap exceeded, not a valid sample");
  rows.push(v);
}
fn wait(s: &State) {
  let pending = std::mem::take(&mut *s.pending.lock().unwrap());
  if pending.is_empty() { return; }
  let t = now(); let cpu = usage(); let counters = rayon_core::census_snapshot();
  for rx in pending { rx.recv().expect("census destructor failed"); }
  record(s, json!({"kind":"wait","site":"diagnostic_wait","start_ns":t,"end_ns":now(),"cpu_start":cpu,"cpu_end":usage(),"counters_start":counters,"counters_end":rayon_core::census_snapshot()}));
}
pub struct Site(Option<Window>);
struct Window {
  state: Arc<State>, site: &'static str, len: usize, min: usize,
  start: u64, cpu: [u64; 5], counters: [u64; 5], sleeping: usize, inactive: usize,
  gap: u64, worker: bool, priority: usize, winner: usize,
}
impl Site {
  pub fn new(site: &'static str, len: usize, min: usize) -> Self {
    let Some(s) = state() else { return Self(None); };
    if s.controlled { wait(&s); }
    Self::with_state(s, site, len, min)
  }
  fn with_state(s: Arc<State>, site: &'static str, len: usize, min: usize) -> Self {
    let (sleeping, inactive) = rayon_core::census_pool_state();
    let start = now();
    let w = Window { priority:s.priority.load(Relaxed), winner:s.winner.load(Relaxed), gap:start.saturating_sub(s.last_exit.load(Relaxed)), worker:rayon::current_thread_index().is_some(), cpu:usage(), counters:rayon_core::census_snapshot(), state:s, site,len,min,start,sleeping,inactive };
    Self(Some(w))
  }
}
impl Drop for Site {
  fn drop(&mut self) {
    if let Some(w) = self.0.take() {
      let counters = rayon_core::census_snapshot(); let cpu = usage(); let end = now();
      w.state.last_exit.store(end, Relaxed);
      record(&w.state, json!({"kind":"site","site":w.site,"len":w.len,"min_len":w.min,"split_eligible":w.len/2>=w.min,"start_ns":w.start,"end_ns":end,"cpu_start":w.cpu,"cpu_end":cpu,"counters_start":w.counters,"counters_end":counters,"sleeping_start":w.sleeping,"inactive_start":w.inactive,"gap_ns":w.gap,"caller_worker":w.worker,"priority":w.priority,"winner":w.winner}));
    }
  }
}
pub fn structural(site: &'static str, values: impl FnOnce() -> Value) {
  if let Some(s) = state() { record(&s, json!({"kind":"structure","site":site,"at_ns":now(),"priority":s.priority.load(Relaxed),"winner":s.winner.load(Relaxed),"values":values()})); }
}
pub fn structural_controlled(site: &'static str, values: impl FnOnce() -> Value) {
  if let Some(s)=state() { if s.controlled { record(&s,json!({"kind":"structure","site":site,"at_ns":now(),"priority":s.priority.load(Relaxed),"winner":s.winner.load(Relaxed),"values":values()})); } }
}
pub fn context(priority: usize, winner: usize) {
  if let Some(s) = state() { s.priority.store(priority,Relaxed); s.winner.store(winner,Relaxed); }
}
pub struct Pass { site: Site, state: Option<Arc<State>> }
impl Pass {
  pub fn new() -> Self {
    if !enabled() { return Self {site:Site(None),state:None}; }
    static IDS: AtomicU64 = AtomicU64::new(0);
    static EXIT: OnceLock<()> = OnceLock::new();
    EXIT.get_or_init(|| { assert_eq!(unsafe { libc::atexit(flush_at_exit) },0); });
    let s = Arc::new(State {id:IDS.fetch_add(1,Relaxed),priority:AtomicUsize::new(usize::MAX),winner:AtomicUsize::new(0),last_exit:AtomicU64::new(0),records:Mutex::new(Vec::with_capacity(16_384)),pending:Mutex::new(Vec::new()),controlled:std::env::var("RSPACK_SC_CENSUS_MODE").as_deref()==Ok("controlled")});
    *active().lock().unwrap()=Some(s.clone());
    Self {site:Site::with_state(s.clone(),"optimize_chunks",0,1),state:Some(s)}
  }
}
impl Drop for Pass {
  fn drop(&mut self) {
    if let Some(s) = &self.state {
      if s.controlled { wait(s); }
      self.site=Site(None);
      *active().lock().unwrap()=None;
      // Snapshot the complete buffered core records. Async closures use the same
      // state and persist their own records after their measured work finishes.
      completed().lock().unwrap().push(s.clone());
    }
  }
}
fn flush(s: &State) {
  use std::io::Write;
  let rows=std::mem::take(&mut *s.records.lock().unwrap());
  if rows.is_empty() { return; }
  let path=std::env::var_os("RSPACK_SC_CENSUS").unwrap();
  let mut file=std::fs::OpenOptions::new().append(true).create(true).open(path).expect("census output unavailable");
  for row in rows { writeln!(file,"{}",json!({"pass":s.id,"mode":if s.controlled {"controlled"} else {"natural"},"row":row})).unwrap(); }
}
pub fn spawn_drop<T: Send + 'static>(site: &'static str, payload: T, len: usize) {
  let Some(s)=state() else { rayon::spawn(move || drop(payload)); return; };
  if s.controlled { wait(&s); }
  let submission=Site::with_state(s.clone(),site,len,1);
  let (tx,rx)=std::sync::mpsc::channel();
  s.pending.lock().unwrap().push(rx);
  rayon::spawn(move || {
    let work=Site::with_state(s.clone(),if site=="previous_drop_submit" {"previous_drop_work"} else {"final_drop_work"},len,1);
    drop(payload); drop(work);
    tx.send(()).ok();

  });
  drop(submission);
}
