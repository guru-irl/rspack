// Bench-only diagnostics. Never enabled by default.
use std::{collections::{BTreeMap, BTreeSet}, sync::{LazyLock, Mutex}, sync::atomic::{AtomicUsize, AtomicBool, Ordering}};
static ENABLED: LazyLock<bool> = LazyLock::new(|| std::env::var("RSPACK_DIAG_INCREMENTAL").is_ok_and(|v| v == "1"));
static ORACLE: LazyLock<bool> = LazyLock::new(|| std::env::var("RSPACK_DIAG_TRANSITIVE_OFF").is_ok_and(|v| v == "1"));
static ORACLE_ACTIVE: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicUsize = AtomicUsize::new(0);
#[derive(Default)]
struct Data { counts: BTreeMap<&'static str, usize>, sets: BTreeMap<&'static str, BTreeSet<u32>> }
static DATA: LazyLock<Mutex<Data>> = LazyLock::new(|| Mutex::new(Data::default()));
pub fn enabled() -> bool { *ENABLED }
pub fn transitive_off() -> bool { *ORACLE && ORACLE_ACTIVE.load(Ordering::Relaxed) }
pub fn activate_oracle(updated: bool) { ORACLE_ACTIVE.store(updated, Ordering::Relaxed); }
pub fn begin() { ORACLE_ACTIVE.store(false, Ordering::Relaxed); GENERATION.fetch_add(1, Ordering::Relaxed); if enabled() { *DATA.lock().expect("diagnostic lock") = Data::default(); } }
pub fn add(key: &'static str, value: usize) { if enabled() { *DATA.lock().expect("diagnostic lock").counts.entry(key).or_default() += value; } }
pub fn key(key: &'static str, value: u32) { if enabled() { DATA.lock().expect("diagnostic lock").sets.entry(key).or_default().insert(value); } }
#[allow(dead_code)]
pub fn has(key: &'static str, value: u32) -> bool { enabled() && DATA.lock().expect("diagnostic lock").sets.get(key).is_some_and(|s| s.contains(&value)) }
pub fn finish() {
 if !enabled() { return; }
 let data = DATA.lock().expect("diagnostic lock");
 let mut counts = data.counts.clone();
 for (key, set) in &data.sets { counts.insert(key, set.len()); }
 if let (Some(fresh), Some(split)) = (data.sets.get("chunk.fresh_hash_key"), data.sets.get("split.created")) { counts.insert("split.fresh_hash_key", fresh.intersection(split).count()); }
 if let (Some(asset), Some(split)) = (data.sets.get("asset.selected"), data.sets.get("split.created")) { counts.insert("split.asset_selected", asset.intersection(split).count()); }
 for (left, right, key) in [("chunk.cause_add", "chunk.cause_module_hash", "chunk.overlap_add_module_hash"), ("chunk.cause_add", "chunk.cause_split_from", "chunk.overlap_add_split_from"), ("chunk.cause_split_from", "chunk.cause_module_hash", "chunk.overlap_split_from_module_hash")] {
  if let (Some(a), Some(b)) = (data.sets.get(left), data.sets.get(right)) { counts.insert(key, a.intersection(b).count()); }
 }
 let fields = counts.iter().map(|(k,v)| format!("\"{k}\":{v}")).collect::<Vec<_>>().join(",");
 eprintln!("RSPACK_DIAG_INCREMENTAL {{\"generation\":{},{} }}", GENERATION.load(Ordering::Relaxed), fields);
}
