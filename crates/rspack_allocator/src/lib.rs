#[global_allocator]
#[cfg(not(any(miri, target_family = "wasm")))]
#[cfg(not(any(
  feature = "sftrace-setup",
  feature = "system-allocator",
  feature = "tracy-client"
)))]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[global_allocator]
#[cfg(not(any(miri, target_family = "wasm")))]
#[cfg(all(feature = "sftrace-setup", not(feature = "system-allocator")))]
static GLOBAL: sftrace_setup::SftraceAllocator<mimalloc::MiMalloc> =
  sftrace_setup::SftraceAllocator(mimalloc::MiMalloc);

#[global_allocator]
#[cfg(not(any(miri, target_family = "wasm")))]
#[cfg(all(feature = "sftrace-setup", feature = "system-allocator"))]
static GLOBAL: sftrace_setup::SftraceAllocator<std::alloc::System> =
  sftrace_setup::SftraceAllocator(std::alloc::System);

#[global_allocator]
#[cfg(not(any(miri, target_family = "wasm")))]
#[cfg(all(feature = "tracy-client", not(feature = "sftrace-setup")))]
static GLOBAL: tracy_client::ProfiledAllocator<std::alloc::System> =
  tracy_client::ProfiledAllocator::new(std::alloc::System, 10); // adjust callstack_depth if needed with performance cost

// Only the configurations below use mimalloc as their global allocator.
#[cfg(all(
  not(any(miri, target_family = "wasm", feature = "system-allocator")),
  any(not(feature = "tracy-client"), feature = "sftrace-setup")
))]
pub mod memory_diagnostic;

#[cfg(not(all(
  not(any(miri, target_family = "wasm", feature = "system-allocator")),
  any(not(feature = "tracy-client"), feature = "sftrace-setup")
)))]
pub mod memory_diagnostic {
  #[inline]
  pub fn record_done(_compiler_id: u32, _graph_stats: impl FnOnce() -> String) {}
}
