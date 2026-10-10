//! Measurement-only slow-path counters. No sampler or scheduling changes.
use std::sync::{OnceLock, atomic::{AtomicU64, Ordering::Relaxed}};
#[repr(align(128))]
pub(crate) struct Counter(AtomicU64);
impl Counter {
    const fn new() -> Self { Self(AtomicU64::new(0)) }
    pub(crate) fn add(&self, n: u64) {
        if enabled() { self.0.fetch_add(n, Relaxed); }
    }
    fn get(&self) -> u64 { self.0.load(Relaxed) }
}
pub(crate) static COLD_OPS: Counter = Counter::new();
pub(crate) static CROSS_OPS: Counter = Counter::new();
pub(crate) static INJECTED: Counter = Counter::new();
pub(crate) static WAKES: Counter = Counter::new();
pub(crate) static SLEEPS: Counter = Counter::new();
pub(crate) fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("RSPACK_SC_CENSUS").is_some_and(|v| !v.is_empty()))
}
pub(crate) fn cold_start() -> Option<u64> { COLD_OPS.add(1); None }
pub(crate) fn cold_finish(_: Option<u64>) {}
/// Fork-only benchmark snapshot, never an upstream public API.
pub fn census_snapshot() -> [u64; 5] {
    [COLD_OPS.get(), CROSS_OPS.get(), INJECTED.get(), WAKES.get(), SLEEPS.get()]
}
