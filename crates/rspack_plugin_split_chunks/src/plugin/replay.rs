use std::hash::{Hash, Hasher};

use rspack_collections::IdentifierMap;
use rspack_core::{ChunkUkey, Compilation, ModuleIdentifier};
use rustc_hash::{FxHashMap, FxHashSet};
use xxhash_rust::xxh64::Xxh64;

use super::{MaxSizeSetting, SplitChunksPlugin};
use crate::{CacheGroup, common::ModuleChunkMap};

pub(super) struct ReplayOptions {
  pub enabled: bool,
  pub strict: bool,
  pub force: bool,
}

impl ReplayOptions {
  pub fn new(enabled: bool) -> Self {
    let value = std::env::var("RSPACK_SPLIT_CHUNKS_REPLAY").unwrap_or_default();
    Self {
      enabled: enabled || matches!(value.as_str(), "1" | "strict" | "force"),
      strict: value == "strict",
      force: value == "force",
    }
  }
}

// Independent seeded lanes hash the actual identifier bytes, not just their
// precomputed 64-bit collection hash. This digest is local to this plugin instance.
struct DigestHasher(Xxh64, Xxh64);
impl Default for DigestHasher {
  fn default() -> Self {
    Self(Xxh64::new(0), Xxh64::new(0x9e3779b97f4a7c15))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum ChunkRef {
  Pre(ChunkUkey),
  Created(usize),
}
impl ChunkRef {
  fn resolve(self, created: &[ChunkUkey]) -> ChunkUkey {
    match self {
      Self::Pre(key) => key,
      Self::Created(index) => created[index],
    }
  }
}

pub(super) enum Placement {
  Shared {
    modules: Vec<ModuleIdentifier>,
    chunks: Vec<ChunkRef>,
  },
  ByModule(Vec<(ModuleIdentifier, Vec<ChunkRef>)>),
}
impl Placement {
  fn for_each(&self, mut visit: impl FnMut(ModuleIdentifier, &[ChunkRef])) {
    match self {
      Self::Shared { modules, chunks } => {
        for module in modules {
          visit(*module, chunks);
        }
      }
      Self::ByModule(edges) => {
        for (module, chunks) in edges {
          visit(*module, chunks);
        }
      }
    }
  }
  fn resolve(&self, created: &[ChunkUkey]) -> ModuleChunkMap {
    let resolve = |chunks: &[ChunkRef]| chunks.iter().map(|chunk| chunk.resolve(created)).collect();
    match self {
      Self::Shared { modules, chunks } => ModuleChunkMap::Shared {
        modules: modules.iter().copied().collect(),
        chunks: resolve(chunks),
      },
      Self::ByModule(edges) => ModuleChunkMap::ByModule(
        edges
          .iter()
          .map(|(module, chunks)| (*module, resolve(chunks)))
          .collect(),
      ),
    }
  }
}

pub(super) enum Event {
  Create {
    name: Option<String>,
  },
  Apply {
    dest: ChunkRef,
    cache_group_index: u32,
    chunk_name: Option<String>,
    placed: Placement,
    used_chunks: Vec<ChunkRef>,
    max_size: bool,
  },
}

pub(super) struct ReplayRecord {
  pub digest: u128,
  pub events: Vec<Event>,
  pub created_count: usize,
}

pub(super) struct Recorder {
  record: ReplayRecord,
  created: FxHashMap<ChunkUkey, usize>,
}
impl Recorder {
  pub fn new(digest: u128) -> Self {
    Self {
      record: ReplayRecord {
        digest,
        events: Vec::new(),
        created_count: 0,
      },
      created: FxHashMap::default(),
    }
  }
  fn chunk_ref(&self, chunk: ChunkUkey) -> ChunkRef {
    self
      .created
      .get(&chunk)
      .map_or(ChunkRef::Pre(chunk), |index| ChunkRef::Created(*index))
  }
  pub fn create(&mut self, chunk: ChunkUkey, name: Option<String>) {
    self.created.insert(chunk, self.record.created_count);
    self.record.created_count += 1;
    self.record.events.push(Event::Create { name });
  }
  pub fn apply(
    &mut self,
    dest: ChunkUkey,
    cache_group_index: u32,
    chunk_name: Option<String>,
    placed: &ModuleChunkMap,
    used: &FxHashSet<ChunkUkey>,
    max_size: bool,
  ) {
    let refs =
      |chunks: &FxHashSet<ChunkUkey>| chunks.iter().map(|chunk| self.chunk_ref(*chunk)).collect();
    let placed = match placed {
      ModuleChunkMap::Shared { modules, chunks } => Placement::Shared {
        modules: modules.iter().copied().collect(),
        chunks: refs(chunks),
      },
      ModuleChunkMap::ByModule(edges) => Placement::ByModule(
        edges
          .iter()
          .map(|(module, chunks)| (*module, refs(chunks)))
          .collect(),
      ),
    };
    self.record.events.push(Event::Apply {
      dest: self.chunk_ref(dest),
      cache_group_index,
      chunk_name,
      placed,
      used_chunks: refs(used),
      max_size,
    });
  }
  pub fn finish(self) -> ReplayRecord {
    self.record
  }
}

impl ReplayRecord {
  // Validate the whole event stream before allocating keys or touching the graph.
  // A sparse virtual graph checks sources created or changed by earlier events too.
  pub fn precheck(&self, compilation: &Compilation) -> Result<(), String> {
    let graph = &compilation.build_chunk_graph_artifact;
    let mut created = 0;
    let mut names = FxHashSet::default();
    let mut edges = FxHashMap::<(ModuleIdentifier, ChunkRef), bool>::default();
    for event in &self.events {
      let valid_ref = |chunk: ChunkRef| match chunk {
        ChunkRef::Pre(key) => graph.chunk_by_ukey.contains(&key),
        ChunkRef::Created(index) => index < created,
      };
      match event {
        Event::Create { name } => {
          if let Some(name) = name
            && (graph.named_chunks.contains_key(name) || !names.insert(name))
          {
            return Err("created chunk name already exists".into());
          }
          created += 1;
        }
        Event::Apply {
          dest,
          placed,
          used_chunks,
          ..
        } => {
          if !valid_ref(*dest) || used_chunks.iter().any(|chunk| !valid_ref(*chunk)) {
            return Err("chunk missing".into());
          }
          let mut failed = false;
          placed.for_each(|module, chunks| {
            for chunk in chunks {
              if !valid_ref(*chunk) {
                failed = true;
                continue;
              }
              let present = edges
                .get(&(module, *chunk))
                .copied()
                .unwrap_or_else(|| match chunk {
                  ChunkRef::Pre(key) => graph.chunk_graph.is_module_in_chunk(&module, *key),
                  ChunkRef::Created(_) => false,
                });
              if !present {
                failed = true;
              }
            }
          });
          if failed {
            return Err("placed source edge missing".into());
          }
          placed.for_each(|module, chunks| {
            let mut moved = false;
            for chunk in chunks {
              if chunk != dest {
                edges.insert((module, *chunk), false);
                moved = true;
              }
            }
            if moved {
              edges.insert((module, *dest), true);
            }
          });
        }
      }
    }
    Ok(())
  }
}

impl SplitChunksPlugin {
  pub(super) fn apply_split_metadata(
    &self,
    dest: ChunkUkey,
    cache_group: &CacheGroup,
    chunk_name: Option<&str>,
    compilation: &mut Compilation,
    settings: &mut FxHashMap<ChunkUkey, MaxSizeSetting>,
  ) {
    let chunk = compilation
      .build_chunk_graph_artifact
      .chunk_by_ukey
      .expect_get_mut(&dest);
    if let Some(reason) = chunk.chunk_reason_mut() {
      reason.push_str(&format!(" (cache group: {})", cache_group.key));
      if let Some(name) = chunk_name {
        reason.push_str(&format!(" (name: {name})"));
      }
    }
    if let Some(filename) = &cache_group.filename {
      chunk.set_filename_template(Some(filename.clone()));
    }
    chunk.add_id_name_hints(cache_group.id_hint.clone());
    if !cache_group.max_initial_size.is_empty() || !cache_group.max_async_size.is_empty() {
      settings.insert(
        dest,
        MaxSizeSetting {
          min_size: cache_group.min_size.clone(),
          max_async_size: cache_group.max_async_size.clone(),
          max_initial_size: cache_group.max_initial_size.clone(),
          automatic_name_delimiter: cache_group.automatic_name_delimiter.clone(),
        },
      );
    }
  }

  pub(super) fn replay_events(
    &self,
    record: &ReplayRecord,
    compilation: &mut Compilation,
  ) -> FxHashMap<ChunkUkey, MaxSizeSetting> {
    let mut created = Vec::with_capacity(record.created_count);
    let mut settings = FxHashMap::default();
    for event in &record.events {
      match event {
        Event::Create { name } => created.push(Self::create_split_chunk(name.clone(), compilation)),
        Event::Apply {
          dest,
          cache_group_index,
          chunk_name,
          placed,
          used_chunks,
          max_size,
        } => {
          let dest = dest.resolve(&created);
          self.apply_split_metadata(
            dest,
            &self.cache_groups[*cache_group_index as usize],
            chunk_name.as_deref(),
            compilation,
            &mut settings,
          );
          let group = &self.cache_groups[*cache_group_index as usize];
          debug_assert_eq!(
            *max_size,
            !group.max_initial_size.is_empty() || !group.max_async_size.is_empty()
          );
          let placed = placed.resolve(&created);
          let used = used_chunks
            .iter()
            .map(|chunk| chunk.resolve(&created))
            .collect();
          self.move_modules_to_new_chunk_and_remove_from_old_chunks(&placed, dest, compilation);
          self.split_from_original_chunks(&used, dest, compilation);
        }
      }
    }
    settings
  }

  /// Replay assumes test/name/chunks depend only on module identity and the chunk
  /// graph. Non-strict mode deliberately retains prior group selection order,
  /// minSize, minSizeReduction, minRemainingSize and enforceSizeThreshold decisions until topology
  /// changes. Size drift can change which chunks a fresh full run would create.
  /// maxSize always uses current sizes. Do not use callbacks that depend on source
  /// or call count.
  pub(super) fn entry_digest(&self, compilation: &Compilation) -> u128 {
    let graph = &compilation.build_chunk_graph_artifact;
    let module_graph = compilation.get_module_graph();
    let mut digest = DigestHasher::default();
    let mut module_hashes = IdentifierMap::default();
    let used_exports = self.cache_groups.iter().any(|group| group.used_exports);
    let mut chunks = graph.chunk_by_ukey.values().collect::<Vec<_>>();
    chunks.sort_unstable_by_key(|chunk| chunk.ukey());
    chunks.len().hash(&mut digest);
    for chunk in chunks {
      chunk.ukey().hash(&mut digest);
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
          if self.replay_options.strict {
            for ty in types {
              module
                .size(Some(ty), Some(compilation))
                .to_bits()
                .hash(&mut hash);
            }
          }
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
      group.chunks.hash(&mut digest);
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
    names.hash(&mut digest);
    digest.digest()
  }
}
