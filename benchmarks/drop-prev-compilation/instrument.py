from pathlib import Path
import sys

root = Path(sys.argv[1])
p = root / 'crates/rspack_allocator/src/lib.rs'
s = p.read_text()
s = s.replace('static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;', 'static GLOBAL: CountingAllocator = CountingAllocator;')
s += '''
use std::alloc::{GlobalAlloc, Layout};
use std::sync::atomic::{AtomicU64, Ordering};

pub static LIVE_BYTES: AtomicU64 = AtomicU64::new(0);
pub static PEAK_BYTES: AtomicU64 = AtomicU64::new(0);
pub static ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);

struct CountingAllocator;
fn record_allocation(bytes: usize) {
  ALLOCATED_BYTES.fetch_add(bytes as u64, Ordering::Relaxed);
  let live = LIVE_BYTES.fetch_add(bytes as u64, Ordering::Relaxed) + bytes as u64;
  PEAK_BYTES.fetch_max(live, Ordering::Relaxed);
}
unsafe impl GlobalAlloc for CountingAllocator {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    let ptr = unsafe { mimalloc::MiMalloc.alloc(layout) };
    if !ptr.is_null() { record_allocation(layout.size()); }
    ptr
  }
  unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
    let ptr = unsafe { mimalloc::MiMalloc.alloc_zeroed(layout) };
    if !ptr.is_null() { record_allocation(layout.size()); }
    ptr
  }
  unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
    LIVE_BYTES.fetch_sub(layout.size() as u64, Ordering::Relaxed);
    unsafe { mimalloc::MiMalloc.dealloc(ptr, layout); }
  }
  unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
    let ptr = unsafe { mimalloc::MiMalloc.realloc(ptr, layout, size) };
    if !ptr.is_null() {
      LIVE_BYTES.fetch_sub(layout.size() as u64, Ordering::Relaxed);
      record_allocation(size);
    }
    ptr
  }
}
'''
p.write_text(s)
p = root / 'crates/rspack_binding_api/src/lib.rs'
s = p.read_text() + '''
#[napi]
pub fn debug_heap_metrics() -> Vec<i64> {
  use std::sync::atomic::Ordering;
  vec![
    rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed) as i64,
    rspack_allocator::PEAK_BYTES.load(Ordering::Relaxed) as i64,
    rspack_allocator::ALLOCATED_BYTES.load(Ordering::Relaxed) as i64,
  ]
}
'''
p.write_text(s)
# rspack_core does not depend on rspack_allocator; expose counters through a
# benchmark-only dependency. No production API changes are committed.
p = root / 'crates/rspack_core/Cargo.toml'
s = p.read_text().replace('[dependencies]', '[dependencies]\nrspack_allocator = { workspace = true }', 1)
p.write_text(s)
p = root / 'crates/rspack_core/src/artifacts/incremental_artifacts.rs'
s = p.read_text()
s = s.replace('self.previous_compilation = None;', 'self.debug_drop_previous();')
s = s.replace('self.previous_compilation = Some(compilation);', 'self.debug_drop_previous();\n    self.previous_compilation = Some(compilation);')
pos = '  pub(crate) fn recover(&mut self, passes: IncrementalPasses, compilation: &mut Compilation) {'
s = s.replace(pos, '''  fn debug_drop_previous(&mut self) {
    use std::sync::atomic::Ordering;
    let Some(mut previous) = self.previous_compilation.take() else { return; };
    let before = rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed);
    let graph = std::mem::take(&mut previous.build_chunk_graph_artifact);
    drop(graph);
    let after_graph = rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed);
    drop(previous);
    let after = rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed);
    eprintln!("PREVIOUS_DROP live_before={} final_graph_freed={} other_freed={} total_freed={}",
      before, before.saturating_sub(after_graph), after_graph.saturating_sub(after), before.saturating_sub(after));
  }

''' + pos)
p.write_text(s)
