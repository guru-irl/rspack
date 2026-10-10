use async_trait::async_trait;

use super::*;
use crate::compilation::pass::PassExt;

pub struct ChunkIdsPass;

#[async_trait]
impl PassExt for ChunkIdsPass {
  fn name(&self) -> &'static str {
    "chunk ids"
  }

  fn incremental_passes(&self) -> IncrementalPasses {
    IncrementalPasses::CHUNK_IDS
  }

  async fn run_pass(&self, compilation: &mut Compilation) -> Result<()> {
    // Check if CHUNK_IDS pass is disabled, and clear artifact if needed
    if !compilation
      .incremental
      .passes_enabled(IncrementalPasses::CHUNK_IDS)
    {
      compilation.named_chunk_ids_artifact.clear();
    }

    let mut diagnostics = vec![];
    let mut chunk_by_ukey = mem::take(&mut compilation.build_chunk_graph_artifact.chunk_by_ukey);
    let mut named_chunk_ids_artifact = compilation.named_chunk_ids_artifact.steal();
    compilation
      .plugin_driver
      .clone()
      .compilation_hooks
      .chunk_ids
      .call(
        compilation,
        &mut chunk_by_ukey,
        &mut named_chunk_ids_artifact,
        &mut diagnostics,
      )
      .await
      .map_err(|e| e.wrap_err("caused by plugins in Compilation.hooks.chunkIds"))?;
    // Compare final hook-chain IDs, before the chunk-aware mutation selectors
    // are first consumed by module hashing. Ukeys may change on reconstruction.
    if compilation
      .chunk_ids_diff_artifact
      .track_effective_ids
      .load(std::sync::atomic::Ordering::Relaxed)
    {
      let mut previous = rustc_hash::FxHashMap::default();
      for (identity, id) in &compilation.chunk_ids_diff_artifact.previous_ids {
        previous
          .entry(identity)
          .and_modify(|id| *id = None)
          .or_insert(Some(id));
      }
      let current = chunk_by_ukey
        .values()
        .map(|chunk| {
          (
            chunk.ukey(),
            crate::ChunkIdIdentity::new(chunk, &compilation.build_chunk_graph_artifact.chunk_graph),
            chunk.id().cloned(),
          )
        })
        .collect::<Vec<_>>();
      let mut unique = rustc_hash::FxHashMap::default();
      for (_, identity, _) in &current {
        unique
          .entry(identity)
          .and_modify(|unique| *unique = false)
          .or_insert(true);
      }
      let mut mutations = compilation.incremental.mutations_write();
      compilation
        .chunk_ids_diff_artifact
        .matched_membership
        .clear();
      for (ukey, identity, id) in &current {
        if unique.get(identity).copied().unwrap_or(false)
          && previous.get(identity).copied().flatten().is_some()
        {
          compilation
            .chunk_ids_diff_artifact
            .matched_membership
            .insert(*ukey);
        }
        if (!unique.get(identity).copied().unwrap_or(false)
          || previous.get(identity).copied().flatten() != id.as_ref())
          && let Some(mutations) = &mut mutations
        {
          mutations.add(Mutation::ChunkSetId { chunk: *ukey });
        }
      }
      drop(mutations);
      drop(unique);
      let pending = current
        .into_iter()
        .filter_map(|(_, identity, id)| id.map(|id| (identity, id)))
        .collect();
      compilation.chunk_ids_diff_artifact.pending_ids = pending;
    }
    compilation.build_chunk_graph_artifact.chunk_by_ukey = chunk_by_ukey;
    compilation.named_chunk_ids_artifact = named_chunk_ids_artifact.into();
    compilation.extend_diagnostics(diagnostics);
    Ok(())
  }
}
