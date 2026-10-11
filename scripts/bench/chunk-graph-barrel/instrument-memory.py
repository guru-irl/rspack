from pathlib import Path
import sys

root = Path(sys.argv[1])
p = root / 'crates/rspack_allocator/src/lib.rs'
s = p.read_text().replace('static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;', 'static GLOBAL: CountingAllocator = CountingAllocator;')
s += '''
use std::alloc::{GlobalAlloc, Layout};
use std::sync::atomic::{AtomicU64, Ordering};
pub static LIVE_BYTES: AtomicU64 = AtomicU64::new(0);
pub static PEAK_BYTES: AtomicU64 = AtomicU64::new(0);
struct CountingAllocator;
fn add(bytes: usize) {
  let live = LIVE_BYTES.fetch_add(bytes as u64, Ordering::Relaxed) + bytes as u64;
  PEAK_BYTES.fetch_max(live, Ordering::Relaxed);
}
unsafe impl GlobalAlloc for CountingAllocator {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    let ptr = unsafe { mimalloc::MiMalloc.alloc(layout) };
    if !ptr.is_null() { add(layout.size()); }
    ptr
  }
  unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
    let ptr = unsafe { mimalloc::MiMalloc.alloc_zeroed(layout) };
    if !ptr.is_null() { add(layout.size()); }
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
      add(size);
    }
    ptr
  }
}
'''
p.write_text(s)
p = root / 'crates/rspack_core/Cargo.toml'
p.write_text(p.read_text().replace('[dependencies]', '[dependencies]\nrspack_allocator = { workspace = true }', 1))
p = root / 'crates/rspack_binding_api/src/lib.rs'
s = p.read_text() + '''
#[napi]
pub fn debug_heap_metrics() -> Vec<i64> {
  use std::sync::atomic::Ordering;
  vec![rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed) as i64,
       rspack_allocator::PEAK_BYTES.load(Ordering::Relaxed) as i64]
}
'''
anchor = '  #[napi(ts_return_type = "Promise<void>")]\n  pub fn close'
s = s.replace(anchor, '''  #[napi]
  pub fn debug_drop_retained(&mut self) -> Vec<i64> {
    self.compiler.debug_drop_retained()
  }

''' + anchor, 1)
p.write_text(s)
p = root / 'crates/rspack_core/src/artifacts/incremental_artifacts.rs'
s = p.read_text().replace('  pub(crate) fn recover(&mut self, passes:', '''  pub(crate) fn debug_drop_retained(&mut self) -> Vec<i64> {
    use std::sync::atomic::Ordering;
    let live = || rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed) as i64;
    let mut values = vec![live()];
    if let Some(previous) = self.previous_compilation.as_mut() {
      drop(std::mem::take(&mut previous.build_chunk_graph_artifact));
    }
    values.push(live());
    self.previous_compilation = None;
    values.push(live());
    drop(std::mem::take(&mut self.build_chunk_graph_artifact_snapshot.code_splitter));
    values.push(live());
    drop(std::mem::take(&mut self.build_chunk_graph_artifact_snapshot));
    values.push(live());
    values
  }

  pub(crate) fn recover(&mut self, passes:''', 1)
p.write_text(s)
p = root / 'packages/rspack/src/Compiler.ts'
s = p.read_text().replace('  #getInstance(', '''  __debugDropRetained(): number[] {
    return this.#instance!.debugDropRetained();
  }

  #getInstance(''', 1)
p.write_text(s)
p = root / 'crates/rspack_core/src/compiler/rebuild.rs'
s = p.read_text() + '''
impl Compiler {
  pub fn debug_drop_retained(&mut self) -> Vec<i64> {
    use std::sync::atomic::Ordering;
    let mut values = self.incremental_artifacts.debug_drop_retained();
    drop(std::mem::take(&mut self.compilation.build_chunk_graph_artifact));
    values.push(rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed) as i64);
    drop(self.compilation.chunk_render_cache_artifact.steal());
    values.push(rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed) as i64);
    drop(self.compilation.code_generate_cache_artifact.steal());
    values.push(rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed) as i64);
    drop(self.compilation.process_runtime_requirements_cache_artifact.steal());
    values.push(rspack_allocator::LIVE_BYTES.load(Ordering::Relaxed) as i64);
    values
  }
}
'''
p.write_text(s)
