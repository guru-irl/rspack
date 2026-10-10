#[global_allocator]
#[cfg(not(any(miri, target_family = "wasm")))]
#[cfg(not(any(
  feature = "sftrace-setup",
  feature = "system-allocator",
  feature = "tracy-client"
)))]
static GLOBAL: live_heap::LiveHeap = live_heap::LiveHeap;

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

#[cfg(not(any(miri, target_family = "wasm")))]
mod live_heap;

/// Measurement only: starts the live-heap sampler when `RSPACK_LIVE_HEAP_LOG` is set.
pub fn start_live_heap_sampler() {
  #[cfg(not(any(miri, target_family = "wasm")))]
  live_heap::start_sampler();
}

#[doc(hidden)]
pub fn measurement_live_bytes() -> isize {
  #[cfg(not(any(miri, target_family = "wasm")))]
  {
    live_heap::measurement_live_bytes()
  }
  #[cfg(any(miri, target_family = "wasm"))]
  {
    0
  }
}
