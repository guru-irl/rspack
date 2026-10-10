use std::sync::Mutex;

use rspack_collections::Identifier;

use crate::{
  ArtifactExt, Chunk, ChunkGraph, ChunkUkey, RuntimeKey, chunk_graph_chunk::ChunkId,
  get_runtime_key, incremental::IncrementalPasses,
};

/// Correspondence across chunk graph reconstruction. Ambiguous identities are
/// never reused. Membership is included: equal root names alone are insufficient.
#[derive(Debug, PartialEq, Eq, Hash)]
pub struct ChunkIdIdentity {
  name: Option<String>,
  facade: bool,
  runtime: RuntimeKey,
  modules: Vec<Identifier>,
}

impl ChunkIdIdentity {
  pub fn new(chunk: &Chunk, chunk_graph: &ChunkGraph) -> Self {
    Self {
      name: chunk.name().map(ToOwned::to_owned),
      facade: chunk.kind() == crate::ChunkKind::Facade,
      runtime: get_runtime_key(chunk.runtime()).clone(),
      modules: chunk_graph.get_ordered_chunk_modules_identifier(&chunk.ukey()),
    }
  }
}

/// Exact allocation domain in natural-comparator order, including reservations.
#[derive(Debug, PartialEq, Eq)]
pub struct DeterministicChunkIdsInputs {
  pub candidates: Vec<(ChunkIdIdentity, String)>,
  pub reserved_ids: Vec<ChunkId>,
  pub context: String,
  pub delimiter: String,
  pub range: usize,
}

/// Pass-owned effective IDs and the proof for unchanged deterministic allocation.
#[derive(Debug, Default)]
pub struct ChunkIdsDiffArtifact {
  /// Corresponds to downstream hashes. Only advanced after hashing succeeds.
  pub previous_ids: Vec<(ChunkIdIdentity, ChunkId)>,
  pub pending_ids: Vec<(ChunkIdIdentity, ChunkId)>,
  /// Reconstructed chunks with identical membership. Their ChunkAdd mutations
  /// still invalidate chunk artifacts, but need not re-hash every member.
  pub matched_membership: rustc_hash::FxHashSet<ChunkUkey>,
  /// No lock is held across a hook, await, or allocation.
  pub deterministic_inputs: Option<DeterministicChunkIdsInputs>,
  pub pending_inputs: Mutex<Option<DeterministicChunkIdsInputs>>,
  /// Opt in only for deterministic allocation; other ID plugins keep their paths.
  pub track_effective_ids: std::sync::atomic::AtomicBool,
}

impl ArtifactExt for ChunkIdsDiffArtifact {
  const PASS: IncrementalPasses = IncrementalPasses::CHUNK_IDS;
}
