use rspack_collections::IdentifierSet;
use rustc_hash::FxHashSet;

use crate::{
  BuildChunkGraphArtifact, ChunkUkey, Compilation,
  artifacts::ArtifactExt,
  incremental::{IncrementalPasses, Mutation},
  recover_artifact,
};

/// Owns the previous compilation artifacts used by incremental passes.
///
/// Artifact recovery is part of incremental compilation itself. It must stay
/// available regardless of which build cache implementation is selected.
#[derive(Debug, Default)]
pub(crate) struct IncrementalArtifacts {
  previous_compilation: Option<Box<Compilation>>,

  // The build chunk graph artifact is mutated by later passes, so recover it
  // from a snapshot captured immediately after its own pass instead of from
  // the final previous compilation.
  build_chunk_graph_artifact_snapshot: BuildChunkGraphArtifact,
}

impl IncrementalArtifacts {
  pub(crate) fn reset(&mut self) {
    self.previous_compilation = None;
    self.build_chunk_graph_artifact_snapshot = BuildChunkGraphArtifact::default();
  }

  pub(crate) fn store_previous_compilation(&mut self, compilation: Box<Compilation>) {
    self.previous_compilation = Some(compilation);
  }

  pub(crate) fn recover(&mut self, passes: IncrementalPasses, compilation: &mut Compilation) {
    if passes.contains(IncrementalPasses::BUILD_CHUNK_GRAPH)
      && BuildChunkGraphArtifact::should_recover(&compilation.incremental)
    {
      BuildChunkGraphArtifact::recover(
        &compilation.incremental,
        &mut compilation.build_chunk_graph_artifact,
        &mut self.build_chunk_graph_artifact_snapshot,
      );
    }

    let Some(previous) = self.previous_compilation.as_mut() else {
      return;
    };
    let incremental = &compilation.incremental;

    if passes.contains(IncrementalPasses::BUILD_MODULE_GRAPH) {
      recover_artifact(
        incremental,
        &mut compilation.build_module_graph_artifact,
        &mut previous.build_module_graph_artifact,
      );
      recover_artifact(
        incremental,
        &mut compilation.exports_info_artifact,
        &mut previous.exports_info_artifact,
      );
    }

    if passes.contains(IncrementalPasses::FINISH_MODULES) {
      recover_artifact(
        incremental,
        &mut compilation.async_modules_artifact,
        &mut previous.async_modules_artifact,
      );
      recover_artifact(
        incremental,
        &mut compilation.dependencies_diagnostics_artifact,
        &mut previous.dependencies_diagnostics_artifact,
      );
    }

    if passes.contains(IncrementalPasses::OPTIMIZE_DEPENDENCIES) {
      recover_artifact(
        incremental,
        &mut compilation.side_effects_optimize_artifact,
        &mut previous.side_effects_optimize_artifact,
      );
    }

    if passes.contains(IncrementalPasses::OPTIMIZE_CHUNK_MODULES) {
      recover_artifact(
        incremental,
        &mut compilation.imported_by_defer_modules_artifact,
        &mut previous.imported_by_defer_modules_artifact,
      );
    }

    if passes.contains(IncrementalPasses::MODULE_IDS) {
      recover_artifact(
        incremental,
        &mut compilation.module_ids_artifact,
        &mut previous.module_ids_artifact,
      );
    }

    if passes.contains(IncrementalPasses::CHUNK_IDS) {
      recover_artifact(
        incremental,
        &mut compilation.named_chunk_ids_artifact,
        &mut previous.named_chunk_ids_artifact,
      );
    }

    if passes.contains(IncrementalPasses::MODULES_HASHES) {
      recover_artifact(
        incremental,
        &mut compilation.cgm_hash_artifact,
        &mut previous.cgm_hash_artifact,
      );
    }

    if passes.contains(IncrementalPasses::MODULES_CODEGEN) {
      recover_artifact(
        incremental,
        &mut compilation.code_generation_results,
        &mut previous.code_generation_results,
      );
      recover_artifact(
        incremental,
        &mut compilation.code_generate_cache_artifact,
        &mut previous.code_generate_cache_artifact,
      );
    }

    if passes.contains(IncrementalPasses::MODULES_RUNTIME_REQUIREMENTS) {
      recover_artifact(
        incremental,
        &mut compilation.cgm_runtime_requirements_artifact,
        &mut previous.cgm_runtime_requirements_artifact,
      );
      recover_artifact(
        incremental,
        &mut compilation.process_runtime_requirements_cache_artifact,
        &mut previous.process_runtime_requirements_cache_artifact,
      );
    }

    if passes.contains(IncrementalPasses::CHUNKS_RUNTIME_REQUIREMENTS) {
      recover_artifact(
        incremental,
        &mut compilation.cgc_runtime_requirements_artifact,
        &mut previous.cgc_runtime_requirements_artifact,
      );
      recover_artifact(
        incremental,
        &mut compilation.runtime_proxy_metadata_artifact,
        &mut previous.runtime_proxy_metadata_artifact,
      );
    }

    if passes.contains(IncrementalPasses::CHUNKS_HASHES) {
      recover_artifact(
        incremental,
        &mut compilation.chunk_hashes_artifact,
        &mut previous.chunk_hashes_artifact,
      );
    }

    if passes.contains(IncrementalPasses::CHUNK_ASSET) {
      recover_artifact(
        incremental,
        &mut compilation.chunk_render_artifact,
        &mut previous.chunk_render_artifact,
      );
      recover_artifact(
        incremental,
        &mut compilation.chunk_render_cache_artifact,
        &mut previous.chunk_render_cache_artifact,
      );
    }
  }

  pub(crate) fn capture(&mut self, passes: IncrementalPasses, compilation: &mut Compilation) {
    if passes.contains(IncrementalPasses::BUILD_CHUNK_GRAPH)
      && BuildChunkGraphArtifact::should_recover(&compilation.incremental)
    {
      BuildChunkGraphArtifact::recover(
        &compilation.incremental,
        &mut self.build_chunk_graph_artifact_snapshot,
        &mut compilation.build_chunk_graph_artifact,
      );
    }

    if passes.contains(IncrementalPasses::CHUNK_IDS) {
      self.record_chunk_group_changes(compilation);
    }
  }

  fn record_chunk_group_changes(&self, compilation: &Compilation) {
    if ![
      IncrementalPasses::MODULES_HASHES,
      IncrementalPasses::CHUNKS_RUNTIME_REQUIREMENTS,
      IncrementalPasses::CHUNKS_HASHES,
      IncrementalPasses::CHUNK_ASSET,
    ]
    .into_iter()
    .any(|pass| compilation.incremental.mutations_readable(pass))
    {
      return;
    }
    let Some(previous) = &self.previous_compilation else {
      return;
    };
    let Some(mut mutations) = compilation.incremental.mutations_write() else {
      return;
    };

    let mut modules = IdentifierSet::default();
    let mut chunks = FxHashSet::default();
    let current_graph = &compilation.build_chunk_graph_artifact;
    let previous_graph = &previous.build_chunk_graph_artifact;
    collect_changed_chunk_group_consumers(
      current_graph,
      previous_graph,
      compilation,
      &mut modules,
      &mut chunks,
    );
    // Removed groups still identify surviving owners and consumers through the
    // previous final graph, not the recovered pre-optimization snapshot.
    collect_changed_chunk_group_consumers(
      previous_graph,
      current_graph,
      compilation,
      &mut modules,
      &mut chunks,
    );
    if !modules.is_empty() || !chunks.is_empty() {
      mutations.add(Mutation::ChunkGroupChunksChanged {
        modules: Box::new(modules),
        chunks: Box::new(chunks),
      });
    }
  }
}

fn collect_changed_chunk_group_consumers(
  graph: &BuildChunkGraphArtifact,
  other: &BuildChunkGraphArtifact,
  compilation: &Compilation,
  modules: &mut IdentifierSet,
  chunks: &mut FxHashSet<ChunkUkey>,
) {
  let mut ancestors = Vec::new();
  let mut initial_descendants = Vec::new();
  let module_graph = compilation.get_module_graph();
  let current_chunks = &compilation.build_chunk_graph_artifact.chunk_by_ukey;
  for group in graph.chunk_group_by_ukey.values() {
    // Snapshot reuse preserves group keys. A rebuilt graph has fresh keys, so
    // every group is changed even if its emitted chunk IDs happen to match.
    if let Some(other_group) = other.chunk_group_by_ukey.get(&group.ukey)
      && group
        .chunks
        .iter()
        .map(|chunk| graph.chunk_by_ukey.expect_get(chunk).id())
        .eq(
          other_group
            .chunks
            .iter()
            .map(|chunk| other.chunk_by_ukey.expect_get(chunk).id()),
        )
    {
      continue;
    }
    modules.extend(
      group
        .origins()
        .iter()
        .filter_map(|origin| origin.module)
        .filter(|module| module_graph.module_by_identifier(module).is_some()),
    );
    ancestors.push(group.ukey);
    if group.is_initial() {
      initial_descendants.push(group.ukey);
    }
  }

  // Parent chunks can cache prefetch and preload work for changed children.
  let mut visited = FxHashSet::default();
  while let Some(key) = ancestors.pop() {
    if !visited.insert(key) {
      continue;
    }
    let group = graph.chunk_group_by_ukey.expect_get(&key);
    chunks.extend(
      group
        .chunks
        .iter()
        .filter(|chunk| current_chunks.contains(chunk)),
    );
    ancestors.extend(group.parents.iter().copied());
  }

  // Entry startup also consumes the chunk lists of initial parent groups.
  let mut visited = FxHashSet::default();
  while let Some(key) = initial_descendants.pop() {
    let group = graph.chunk_group_by_ukey.expect_get(&key);
    if !group.is_initial() || !visited.insert(key) {
      continue;
    }
    chunks.extend(
      group
        .chunks
        .iter()
        .filter(|chunk| current_chunks.contains(chunk)),
    );
    initial_descendants.extend(group.children.iter().copied());
  }
}
