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

/// Collect already-freed pages and expired process-wide arena purges.
/// A no-op unless mimalloc is the global allocator.
pub fn collect() {
  #[cfg(all(
    not(any(miri, target_family = "wasm", feature = "system-allocator")),
    any(not(feature = "tracy-client"), feature = "sftrace-setup")
  ))]
  {
    // Sftrace wraps MiMalloc; Tracy alone wraps System.
    // SAFETY: mi_collect has no preconditions. It collects only the calling
    // thread's heap plus arena purges, not every worker's thread-local heap.
    unsafe { libmimalloc_sys::mi_collect(false) };
  }
}
