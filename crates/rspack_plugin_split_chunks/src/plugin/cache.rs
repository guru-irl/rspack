use std::{
  hash::{Hash, Hasher},
  sync::{Arc, LazyLock, Mutex, OnceLock},
};

use rspack_collections::{IdentifierMap, SsoHashSet};
use rspack_core::{ChunkUkey, Compilation, ModuleIdentifier};
use rustc_hash::{FxHashMap, FxHashSet};
use xxhash_rust::xxh64::Xxh64;

use super::{
  ModuleGroupMap, SplitChunksPlugin,
  module_group::{IntersectionPruning, PreparedCandidate},
};
use crate::{
  common::ModuleSizes,
  module_group::{ModuleGroupKey, ModuleGroupSnapshot},
};

static VERIFY: LazyLock<bool> = LazyLock::new(|| {
  std::env::var_os("RSPACK_SPLIT_CHUNKS_STRUCTURE_VERIFY").as_deref()
    == Some(std::ffi::OsStr::new("1"))
});
pub(super) fn verification_enabled() -> bool {
  *VERIFY
}

// Original chunks retain their graph identity. Destinations allocated by this run use
// their creation order so equivalent later phases do not depend on allocation counters.
#[derive(Hash, PartialEq, Eq, PartialOrd, Ord)]
enum PhaseChunkKey {
  Original(ChunkUkey),
  Created(usize),
}

#[derive(Default)]
pub(super) struct PhaseChunkKeys {
  created: FxHashMap<ChunkUkey, usize>,
}

impl PhaseChunkKeys {
  pub fn record_created(&mut self, chunk: ChunkUkey) {
    let ordinal = self.created.len();
    self.created.entry(chunk).or_insert(ordinal);
  }

  fn key(&self, chunk: ChunkUkey) -> PhaseChunkKey {
    self
      .created
      .get(&chunk)
      .map_or(PhaseChunkKey::Original(chunk), |ordinal| {
        PhaseChunkKey::Created(*ordinal)
      })
  }
}

pub(super) struct CacheStructure {
  pub digest: u128,
  phases: Mutex<Vec<Option<Arc<PreparedPhase>>>>,
  order_safe: OnceLock<bool>,
}
impl CacheStructure {
  pub fn new(digest: u128) -> Self {
    Self {
      digest,
      phases: Mutex::new(Vec::new()),
      order_safe: OnceLock::new(),
    }
  }
  pub fn order_safe(
    &self,
    plugin: &SplitChunksPlugin,
    modules: &[ModuleIdentifier],
    compilation: &Compilation,
  ) -> bool {
    *self
      .order_safe
      .get_or_init(|| plugin.structure_order_safe(modules, compilation))
  }
  pub fn phase(&self, index: usize, digest: u128) -> Option<Arc<PreparedPhase>> {
    let mut phases = self.phases.lock().expect("structure phases lock");
    let phase = phases.get_mut(index)?;
    if phase.as_ref().is_some_and(|value| value.digest != digest) {
      *phase = None;
    }
    phase.as_ref().map(Arc::clone)
  }
  pub fn insert(&self, index: usize, phase: PreparedPhase) {
    let mut phases = self.phases.lock().expect("structure phases lock");
    if phases.len() <= index {
      phases.resize_with(index + 1, || None);
    }
    phases[index] = Some(Arc::new(phase));
  }
  pub fn invalidate(&self, index: usize) {
    if let Some(phase) = self
      .phases
      .lock()
      .expect("structure phases lock")
      .get_mut(index)
    {
      *phase = None;
    }
  }
  pub fn logical_bytes(&self) -> usize {
    let phases = self.phases.lock().expect("structure phases lock");
    std::mem::size_of::<Self>()
      + 2 * std::mem::size_of::<usize>()
      + phases.capacity() * std::mem::size_of::<Option<Arc<PreparedPhase>>>()
      + phases
        .iter()
        .flatten()
        .map(|phase| phase.logical_bytes())
        .sum::<usize>()
  }
}

struct PreparedEntry {
  key: ModuleGroupKey,
  group: ModuleGroupSnapshot,
  intersection: Option<(bool, usize)>,
}
pub(super) struct PreparedPhase {
  pub digest: u128,
  entries: Vec<PreparedEntry>,
  pruning: [Option<IntersectionPruning>; 2],
  pub size_reads: Vec<rspack_core::ModuleSizeRead>,
  pub size_read_calls: usize,
}
impl PreparedPhase {
  pub fn capture(
    digest: u128,
    candidates: &[PreparedCandidate],
    pruning: [Option<IntersectionPruning>; 2],
    reads: rspack_core::ModuleReadSet,
  ) -> Self {
    let entries = candidates
      .iter()
      .map(|candidate| PreparedEntry {
        key: candidate.key.clone(),
        group: candidate.group.snapshot(),
        intersection: candidate.intersection,
      })
      .collect();
    Self {
      digest,
      entries,
      pruning,
      size_reads: reads.sizes,
      size_read_calls: reads.size_calls,
    }
  }
  pub fn validate_size_reads(&self, compilation: &Compilation) -> bool {
    let graph = compilation.get_module_graph();
    self.size_reads.iter().all(|read| {
      graph
        .module_by_identifier(&read.module)
        .is_some_and(|module| {
          module
            .size(read.source_type.as_ref(), Some(compilation))
            .to_bits()
            == read.value_bits
        })
    })
  }
  pub fn clone_candidates(&self) -> Vec<PreparedCandidate> {
    self
      .entries
      .iter()
      .map(|entry| PreparedCandidate {
        key: entry.key.clone(),
        group: entry.group.restore(),
        intersection: entry.intersection,
      })
      .collect()
  }
  pub fn into_current_map(
    candidates: Vec<PreparedCandidate>,
    pruning: &[Option<IntersectionPruning>; 2],
    plugin: &SplitChunksPlugin,
    module_sizes: &ModuleSizes,
    compilation: &Compilation,
  ) -> ModuleGroupMap {
    let allowed = pruning.each_ref().map(|pruning| {
      pruning
        .as_ref()
        .map(|pruning| pruning.allowed(&plugin.cache_groups, module_sizes, compilation))
    });
    let candidates = candidates
      .into_iter()
      .filter(|candidate| {
        candidate.intersection.is_none_or(|(exports, index)| {
          allowed[usize::from(exports)]
            .as_ref()
            .is_none_or(|allowed| allowed[index])
        })
      })
      .collect::<Vec<_>>();
    let mut groups = ModuleGroupMap::with_capacity_and_hasher(candidates.len(), Default::default());
    groups.extend(
      candidates
        .into_iter()
        .map(|candidate| (candidate.key, candidate.group)),
    );
    groups
  }
  pub fn restore(
    &self,
    candidates: Vec<PreparedCandidate>,
    plugin: &SplitChunksPlugin,
    module_sizes: &ModuleSizes,
    compilation: &Compilation,
  ) -> ModuleGroupMap {
    Self::into_current_map(candidates, &self.pruning, plugin, module_sizes, compilation)
  }
  pub fn assert_matches(
    &self,
    phase: usize,
    candidates: &mut [PreparedCandidate],
    pruning: &[Option<IntersectionPruning>; 2],
    sizes: &ModuleSizes,
  ) {
    assert_eq!(
      self.entries.len(),
      candidates.len(),
      "structure candidate count mismatch at phase {phase}"
    );
    assert_eq!(
      &self.pruning, pruning,
      "structure support mismatch at phase {phase}"
    );
    for (cached, fresh) in self.entries.iter().zip(candidates) {
      assert!(
        cached.key == fresh.key
          && cached.intersection == fresh.intersection
          && cached.group.same_structure(&fresh.group),
        "structure mismatch at phase {phase}, key {}",
        fresh.key
      );
      let mut restored = cached.group.restore();
      fresh.group.prepare_modules_for_sizes_and_compare();
      let expected = fresh.group.get_sizes(sizes);
      let actual = restored.get_sizes(sizes);
      assert!(
        expected.len() == actual.len()
          && expected.iter().all(|(ty, size)| actual
            .get(ty)
            .is_some_and(|actual| actual.to_bits() == size.to_bits())),
        "structure size mismatch at phase {phase}, key {}",
        fresh.key
      );
      assert_eq!(
        fresh.group.get_total_size().to_bits(),
        restored.get_total_size().to_bits(),
        "structure total mismatch at phase {phase}, key {}",
        fresh.key
      );
    }
  }
  fn logical_bytes(&self) -> usize {
    std::mem::size_of::<Self>()
      + self.size_reads.capacity() * std::mem::size_of::<rspack_core::ModuleSizeRead>()
      + 2 * std::mem::size_of::<usize>()
      + self.entries.capacity() * std::mem::size_of::<PreparedEntry>()
      + self
        .entries
        .iter()
        .map(|entry| {
          entry.group.logical_bytes()
            + match &entry.key {
              ModuleGroupKey::Named { chunk_name, .. } => chunk_name.capacity(),
              ModuleGroupKey::Anonymous { .. } => 0,
            }
        })
        .sum::<usize>()
      + self
        .pruning
        .iter()
        .flatten()
        .map(IntersectionPruning::logical_bytes)
        .sum::<usize>()
  }
}

#[derive(Clone, Copy)]
pub(super) enum PhaseOutcome {
  Hit,
  TrackedReadChanged,
  UntrackableRead,
  ShapeGuard,
  DigestMiss,
  SizeSafety,
  ReuseAmbiguity,
  Ordering,
  Disabled,
}
impl PhaseOutcome {
  pub fn label(self) -> &'static str {
    match self {
      Self::Hit => "hit",
      Self::TrackedReadChanged => "tracked_read_changed",
      Self::UntrackableRead => "untrackable_read",
      Self::ShapeGuard => "shape_guard",
      Self::DigestMiss => "digest_miss",
      Self::SizeSafety => "size_safety",
      Self::ReuseAmbiguity => "reuse_ambiguity",
      Self::Ordering => "ordering",
      Self::Disabled => "disabled",
    }
  }
}

pub(super) fn exact_size_arithmetic(sizes: &ModuleSizes, chunks: usize) -> bool {
  const LIMIT: u64 = 1 << 53;
  sizes
    .values()
    .flat_map(|sizes| sizes.values())
    .try_fold(0u64, |sum, size| {
      if !(0.0..=LIMIT as f64).contains(size) || size.fract() != 0.0 {
        return None;
      }
      sum.checked_add(*size as u64).filter(|sum| *sum <= LIMIT)
    })
    .and_then(|sum| sum.checked_mul(chunks.max(1) as u64))
    .is_some_and(|sum| sum <= LIMIT)
}

struct DigestHasher(Xxh64, Xxh64);
impl Default for DigestHasher {
  fn default() -> Self {
    Self(Xxh64::new(0), Xxh64::new(0x9e37_79b9_7f4a_7c15))
  }
}
impl Hasher for DigestHasher {
  fn finish(&self) -> u64 {
    self.0.finish()
  }
  fn write(&mut self, bytes: &[u8]) {
    self.0.write(bytes);
    self.1.write(bytes);
  }
}
impl DigestHasher {
  fn digest(&self) -> u128 {
    u128::from(self.0.finish()) | (u128::from(self.1.finish()) << 64)
  }
}

impl SplitChunksPlugin {
  fn structure_order_safe(&self, modules: &[ModuleIdentifier], compilation: &Compilation) -> bool {
    if self
      .cache_groups
      .iter()
      .any(|group| !group.priority.is_finite())
      || modules
        .windows(2)
        .any(|pair| pair[0].precomputed_hash() == pair[1].precomputed_hash())
    {
      return false;
    }
    let mut delimiters = FxHashSet::default();
    for group in &self.cache_groups {
      if !group.max_async_size.is_empty() || !group.max_initial_size.is_empty() {
        delimiters.insert(group.automatic_name_delimiter.as_str());
      }
    }
    if !self.fallback_cache_group.max_async_size.is_empty()
      || !self.fallback_cache_group.max_initial_size.is_empty()
    {
      delimiters.insert(self.fallback_cache_group.automatic_name_delimiter.as_str());
    }
    let graph = compilation.get_module_graph();
    delimiters.into_iter().all(|delimiter| {
      let mut keys = FxHashSet::default();
      modules.iter().all(|module| {
        keys.insert(super::max_size::get_key(
          graph
            .module_by_identifier(module)
            .expect("module should exist")
            .as_ref(),
          delimiter,
          compilation,
        ))
      })
    })
  }

  #[allow(clippy::too_many_arguments)]
  pub(super) fn phase_digest(
    &self,
    root: u128,
    phase: usize,
    compilation: &Compilation,
    modules: &[ModuleIdentifier],
    available: &[SsoHashSet<ChunkUkey>],
    indices: &FxHashMap<ChunkUkey, u32>,
    chunk_keys: &PhaseChunkKeys,
  ) -> u128 {
    let mut hash = DigestHasher::default();
    root.hash(&mut hash);
    if phase != 0 {
      self
        .entry_digest_with_chunk_keys(compilation, chunk_keys)
        .hash(&mut hash);
    }
    modules.hash(&mut hash);
    let module_graph = compilation.get_module_graph();
    for identifier in modules {
      let module = module_graph
        .module_by_identifier(identifier)
        .expect("module should exist");
      module.as_ref().as_any().type_id().hash(&mut hash);
      module
        .as_normal_module()
        .map(|module| module.resource_resolved_data().resource())
        .hash(&mut hash);
      module.module_type().as_str().hash(&mut hash);
      module.get_layer().hash(&mut hash);
      rspack_core::ChunkGraph::get_module_id(&compilation.module_ids_artifact, *identifier)
        .hash(&mut hash);
    }
    for chunks in available {
      chunks.len().hash(&mut hash);
      for chunk in chunks {
        chunk.hash(&mut hash);
      }
    }
    let mut ordered_indices = indices.iter().collect::<Vec<_>>();
    ordered_indices.sort_unstable_by_key(|(chunk, _)| **chunk);
    ordered_indices.hash(&mut hash);
    let graph = &compilation.build_chunk_graph_artifact;
    let mut chunks = graph.chunk_by_ukey.values().collect::<Vec<_>>();
    chunks.sort_unstable_by_key(|chunk| chunk_keys.key(chunk.ukey()));
    for chunk in chunks {
      chunk_keys.key(chunk.ukey()).hash(&mut hash);
      chunk.id().hash(&mut hash);
      chunk
        .filename_template()
        .and_then(|value| value.template())
        .hash(&mut hash);
      chunk
        .css_filename_template()
        .and_then(|value| value.template())
        .hash(&mut hash);
      chunk.id_name_hints().len().hash(&mut hash);
      for hint in chunk.id_name_hints() {
        hint.hash(&mut hash);
      }
      for runtime in chunk.runtime().iter() {
        runtime.hash(&mut hash);
      }
      let entries = graph
        .chunk_graph
        .get_chunk_entry_modules_with_chunk_group_iterable(&chunk.ukey());
      entries.len().hash(&mut hash);
      for (module, group) in entries {
        module.hash(&mut hash);
        group.hash(&mut hash);
      }
      for module in graph
        .chunk_graph
        .get_chunk_modules_identifier(&chunk.ukey())
      {
        module.hash(&mut hash);
      }
      for group in chunk.groups() {
        group.hash(&mut hash);
      }
    }
    let mut names = graph.named_chunks.iter().collect::<Vec<_>>();
    names.sort_unstable_by_key(|(name, _)| *name);
    names.len().hash(&mut hash);
    for (name, chunk) in names {
      name.hash(&mut hash);
      chunk_keys.key(*chunk).hash(&mut hash);
    }
    hash.digest()
  }

  pub(super) fn entry_digest(&self, compilation: &Compilation) -> u128 {
    self.entry_digest_with_chunk_keys(compilation, &PhaseChunkKeys::default())
  }

  fn entry_digest_with_chunk_keys(
    &self,
    compilation: &Compilation,
    chunk_keys: &PhaseChunkKeys,
  ) -> u128 {
    let graph = &compilation.build_chunk_graph_artifact;
    let module_graph = compilation.get_module_graph();
    let mut digest = DigestHasher::default();
    let mut module_hashes = IdentifierMap::default();
    let used_exports = self.cache_groups.iter().any(|group| group.used_exports);
    let mut chunks = graph.chunk_by_ukey.values().collect::<Vec<_>>();
    chunks.sort_unstable_by_key(|chunk| chunk_keys.key(chunk.ukey()));
    chunks.len().hash(&mut digest);
    for chunk in chunks {
      chunk_keys.key(chunk.ukey()).hash(&mut digest);
      chunk.name().hash(&mut digest);
      chunk.runtime().hash(&mut digest);
      chunk
        .has_runtime(&graph.chunk_group_by_ukey)
        .hash(&mut digest);
      graph
        .chunk_graph
        .get_number_of_entry_modules(&chunk.ukey())
        .hash(&mut digest);
      std::mem::discriminant(&chunk.kind()).hash(&mut digest);
      let mut groups = chunk.groups().iter().copied().collect::<Vec<_>>();
      groups.sort_unstable();
      groups.hash(&mut digest);
      let modules = graph
        .chunk_graph
        .get_chunk_modules_identifier(&chunk.ukey());
      let mut sum = 0u128;
      let mut xor = 0u128;
      for identifier in modules {
        let hash = *module_hashes.entry(*identifier).or_insert_with(|| {
          let module = module_graph
            .module_by_identifier(identifier)
            .expect("chunk module exists");
          let mut hash = DigestHasher::default();
          identifier.as_str().hash(&mut hash);
          module.name_for_condition().hash(&mut hash);
          module.module_type().hash(&mut hash);
          module.get_layer().hash(&mut hash);
          let types = module.source_types(module_graph);
          types.hash(&mut hash);

          hash.digest()
        });
        let hash = if used_exports {
          let mut usage = DigestHasher::default();
          hash.hash(&mut usage);
          compilation
            .exports_info_artifact
            .get_exports_info_data(identifier)
            .get_usage_key(Some(chunk.runtime()))
            .hash(&mut usage);
          usage.digest()
        } else {
          hash
        };
        sum = sum.wrapping_add(hash);
        xor ^= hash;
      }
      (modules.len(), sum, xor).hash(&mut digest);
    }
    let mut groups = graph.chunk_group_by_ukey.values().collect::<Vec<_>>();
    groups.sort_unstable_by_key(|group| group.ukey());
    groups.len().hash(&mut digest);
    for group in groups {
      group.ukey().hash(&mut digest);
      std::mem::discriminant(&group.kind).hash(&mut digest);
      group.is_initial().hash(&mut digest);
      group.name().hash(&mut digest);
      group.index.hash(&mut digest);
      group.chunks.len().hash(&mut digest);
      for chunk in &group.chunks {
        chunk_keys.key(*chunk).hash(&mut digest);
      }
      let mut parents = group.parents.iter().copied().collect::<Vec<_>>();
      parents.sort_unstable();
      parents.hash(&mut digest);
      group.children.len().hash(&mut digest);
      for child in &group.children {
        child.hash(&mut digest);
      }
    }
    let mut names = graph.named_chunks.iter().collect::<Vec<_>>();
    names.sort_unstable_by(|a, b| a.0.cmp(b.0));
    names.len().hash(&mut digest);
    for (name, chunk) in names {
      name.hash(&mut digest);
      chunk_keys.key(*chunk).hash(&mut digest);
    }
    digest.digest()
  }
}
