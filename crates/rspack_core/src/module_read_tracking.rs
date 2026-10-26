use std::sync::{
  Arc, LazyLock, Mutex,
  atomic::{AtomicUsize, Ordering},
};

use rustc_hash::FxHashMap;

use crate::{CompilerId, ModuleIdentifier, SourceType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModuleSizeRead {
  pub module: ModuleIdentifier,
  pub source_type: Option<SourceType>,
  pub value_bits: u64,
}

#[derive(Default)]
pub struct ModuleReadSet {
  pub sizes: Vec<ModuleSizeRead>,
  pub size_calls: usize,
  pub untrackable: bool,
}

#[derive(Default)]
struct ReadState {
  sizes: FxHashMap<(ModuleIdentifier, Option<SourceType>), u64>,
  size_calls: usize,
  untrackable: bool,
}

type SharedReads = Arc<Mutex<ReadState>>;
static READERS: LazyLock<Mutex<FxHashMap<CompilerId, SharedReads>>> =
  LazyLock::new(|| Mutex::new(FxHashMap::default()));
static ACTIVE_READERS: AtomicUsize = AtomicUsize::new(0);

// Binding accessors record reads; the native bundling algorithm does not.
pub struct ModuleReadSession {
  compiler: CompilerId,
  reads: SharedReads,
  active: bool,
}

impl ModuleReadSession {
  pub fn new(compiler: CompilerId) -> Self {
    let reads = Arc::new(Mutex::new(ReadState::default()));
    let mut readers = READERS.lock().expect("module readers lock");
    assert!(
      !readers.contains_key(&compiler),
      "module read sessions must not overlap for one compiler"
    );
    readers.insert(compiler, Arc::clone(&reads));
    ACTIVE_READERS.fetch_add(1, Ordering::Release);
    Self {
      compiler,
      reads,
      active: true,
    }
  }

  fn detach(&mut self) {
    if self.active {
      READERS
        .lock()
        .expect("module readers lock")
        .remove(&self.compiler);
      ACTIVE_READERS.fetch_sub(1, Ordering::Release);
      self.active = false;
    }
  }

  pub fn finish(mut self) -> ModuleReadSet {
    self.detach();
    let state = std::mem::take(&mut *self.reads.lock().expect("module reads lock"));
    let mut sizes = state
      .sizes
      .into_iter()
      .map(|((module, source_type), value_bits)| ModuleSizeRead {
        module,
        source_type,
        value_bits,
      })
      .collect::<Vec<_>>();
    sizes.sort_unstable_by_key(|read| (read.module, read.source_type));
    ModuleReadSet {
      sizes,
      size_calls: state.size_calls,
      untrackable: state.untrackable,
    }
  }
}

impl Drop for ModuleReadSession {
  fn drop(&mut self) {
    self.detach();
  }
}

fn active_reads(compiler: CompilerId) -> Option<SharedReads> {
  if ACTIVE_READERS.load(Ordering::Acquire) == 0 {
    return None;
  }
  READERS
    .lock()
    .expect("module readers lock")
    .get(&compiler)
    .map(Arc::clone)
}

pub fn record_module_size_read(
  compiler: CompilerId,
  module: ModuleIdentifier,
  source_type: Option<SourceType>,
  value: f64,
) {
  let Some(reads) = active_reads(compiler) else {
    return;
  };
  let mut reads = reads.lock().expect("module reads lock");
  reads.size_calls += 1;
  let bits = value.to_bits();
  if reads
    .sizes
    .insert((module, source_type), bits)
    .is_some_and(|previous| previous != bits)
  {
    reads.untrackable = true;
  }
}

pub fn record_untrackable_module_read(compiler: CompilerId) {
  if let Some(reads) = active_reads(compiler) {
    reads.lock().expect("module reads lock").untrackable = true;
  }
}
