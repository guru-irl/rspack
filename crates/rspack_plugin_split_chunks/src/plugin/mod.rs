mod bitmap;
mod cache;
mod chunk;
mod intersections;
mod max_request;
pub mod max_size;
pub mod min_size;
mod module_group;
mod residual;

use std::{
  borrow::Cow,
  cmp::Ordering,
  fmt::Debug,
  sync::{Arc, Mutex, OnceLock},
  time::Instant,
};

use futures::future::BoxFuture;
use itertools::Itertools;
use rayon::iter::{IntoParallelRefIterator, IntoParallelRefMutIterator, ParallelIterator};
use rspack_collections::IdentifierMap;
use rspack_core::{ChunkUkey, Compilation, CompilationOptimizeChunks, Logger, Plugin};
use rspack_error::Result;
use rspack_hook::{plugin, plugin_hook};
use rspack_util::{fx_hash::FxIndexMap, tracing_preset::TRACING_BENCH_TARGET};
use rustc_hash::{FxHashMap, FxHashSet};
use tracing::instrument;

use crate::{
  CacheGroup, ChunkNameGetter, SplitChunkSizes,
  common::{FallbackCacheGroup, ModuleChunkMap},
  get_module_sizes,
  module_group::{IndexedCacheGroup, ModuleGroup, ModuleGroupKey},
  options::chunk_name::ChunkNameGetterFnCtx,
};

type ModuleGroupMap = FxIndexMap<ModuleGroupKey, ModuleGroup>;

fn experimental_cache_enabled(config: bool) -> bool {
  static OVERRIDE: OnceLock<Option<bool>> = OnceLock::new();
  OVERRIDE
    .get_or_init(
      || match std::env::var("RSPACK_SPLIT_CHUNKS_EXPERIMENTAL_CACHE").as_deref() {
        Ok("1") => Some(true),
        Ok("0") => Some(false),
        _ => None,
      },
    )
    .unwrap_or(config)
}

fn size_check_skipped() -> bool {
  static SKIP: OnceLock<bool> = OnceLock::new();
  *SKIP.get_or_init(|| {
    matches!(
      std::env::var("RSPACK_SPLIT_CHUNKS_CACHE_SKIP_SIZE_CHECK").as_deref(),
      Ok("1")
    )
  })
}

#[doc(hidden)]
pub type SplitChunksNameBatchFn = Arc<
  dyn for<'a> Fn(Vec<ChunkNameGetterFnCtx<'a>>) -> BoxFuture<'static, Result<Vec<Option<String>>>>
    + Sync
    + Send,
>;

#[derive(Debug)]
pub struct ModuleShapeCheckResult {
  pub reusable: bool,
  pub checked: u32,
  pub custom: u32,
  pub prototype_changed: bool,
}

#[derive(Clone)]
pub struct ModuleShapeCheckFn(
  pub  Arc<
    dyn Fn(rspack_core::CompilerId) -> BoxFuture<'static, Result<ModuleShapeCheckResult>>
      + Send
      + Sync,
  >,
);
impl Debug for ModuleShapeCheckFn {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("ModuleShapeCheckFn")
  }
}

#[derive(Debug)]
pub struct PluginOptions {
  pub experimental_cache: bool,
  pub module_shape_check: Option<ModuleShapeCheckFn>,
  pub dedup_depth: u32,
  pub cache_groups: Vec<CacheGroup>,
  pub fallback_cache_group: FallbackCacheGroup,
  pub hide_path_info: Option<bool>,
}

#[plugin]
pub struct SplitChunksPlugin {
  dedup_depth: u32,
  cache_groups: Box<[CacheGroup]>,
  name_batch_getters: Option<Box<[Option<SplitChunksNameBatchFn>]>>,
  fallback_cache_group: FallbackCacheGroup,
  hide_path_info: bool,
  cache_enabled: bool,
  module_shape_check: Option<ModuleShapeCheckFn>,
  cache_structure: Mutex<Option<Arc<cache::CacheStructure>>>,
  last_compilation: Mutex<Option<rspack_core::CompilationId>>,
}

impl SplitChunksPlugin {
  pub fn new(mut options: PluginOptions) -> Self {
    options.experimental_cache = experimental_cache_enabled(options.experimental_cache);
    tracing::debug!("Create `SplitChunksPlugin` with {:#?}", options);
    Self::new_inner(
      options.dedup_depth,
      options.cache_groups.into(),
      None,
      options.fallback_cache_group,
      options.hide_path_info.unwrap_or(false),
      options.experimental_cache,
      options.module_shape_check,
      Mutex::new(None),
      Mutex::new(None),
    )
  }

  #[doc(hidden)]
  pub fn new_with_name_batch_getters(
    mut options: PluginOptions,
    name_batch_getters: Vec<Option<SplitChunksNameBatchFn>>,
  ) -> Self {
    assert_eq!(
      options.cache_groups.len(),
      name_batch_getters.len(),
      "name batch getters should align with cache groups"
    );
    options.experimental_cache = experimental_cache_enabled(options.experimental_cache);
    let name_batch_getters = name_batch_getters
      .iter()
      .any(Option::is_some)
      .then(|| name_batch_getters.into());
    tracing::debug!("Create `SplitChunksPlugin` with {:#?}", options);
    Self::new_inner(
      options.dedup_depth,
      options.cache_groups.into(),
      name_batch_getters,
      options.fallback_cache_group,
      options.hide_path_info.unwrap_or(false),
      options.experimental_cache,
      options.module_shape_check,
      Mutex::new(None),
      Mutex::new(None),
    )
  }
  #[instrument(name = "Compilation:SplitChunks",target=TRACING_BENCH_TARGET, skip_all)]
  async fn inner_impl(&self, compilation: &mut Compilation) -> Result<()> {
    let logger = compilation.get_logger(self.name());
    if !self.cache_enabled {
      let settings = self.full_impl(compilation, None).await?;
      let start = logger.time("ensure max size fit");
      self.ensure_max_size_fit(compilation, &settings).await?;
      logger.time_end(start);
      return Ok(());
    }
    let (first_invocation, first_compilation) = {
      let mut last = self
        .last_compilation
        .lock()
        .expect("cache compilation lock");
      let first_compilation = last.is_none();
      let first = *last != Some(compilation.id());
      *last = Some(compilation.id());
      (first, first_compilation)
    };
    if !first_invocation {
      let settings = self.full_impl(compilation, None).await?;
      let start = logger.time("ensure max size fit");
      self.ensure_max_size_fit(compilation, &settings).await?;
      logger.time_end(start);
      return Ok(());
    }
    // Functions may use only their module object and other supplied arguments, not mutable closure state, globals, or side tables.
    // Take the old structure before fallible work so a failed run cannot retain it.
    let previous = self
      .cache_structure
      .lock()
      .expect("cache structure lock")
      .take();
    let shape_timer = logger.time("check module object shapes");
    let shapes = if let Some(check) = &self.module_shape_check {
      (check.0)(compilation.compiler_id()).await?
    } else {
      ModuleShapeCheckResult {
        reusable: false,
        checked: 0,
        custom: 0,
        prototype_changed: false,
      }
    };
    logger.time_end(shape_timer);
    logger.info(format!(
      "module object shapes: checked={} custom={} prototype_changed={} reusable={}",
      shapes.checked, shapes.custom, shapes.prototype_changed, shapes.reusable
    ));
    let active = compilation.options.mode.is_development() && shapes.reusable;
    let errors_present = compilation.get_errors().next().is_some();
    let digest_start = Instant::now();
    let digest = (active && !errors_present).then(|| self.entry_digest(compilation));
    let digest_ms = if digest.is_some() {
      digest_start.elapsed().as_secs_f64() * 1000.0
    } else {
      0.0
    };
    let hit = digest.as_ref().is_some_and(|digest| {
      previous
        .as_ref()
        .is_some_and(|structure| structure.digest == *digest)
    });
    let reason = if !active {
      if !shapes.reusable {
        "disabled: module object shape"
      } else {
        "disabled: mode is not development"
      }
    } else if errors_present {
      "errors present"
    } else if previous.is_none() {
      "no record"
    } else {
      "structure changed"
    };
    let structure = digest.map(|digest| {
      previous
        .filter(|structure| structure.digest == digest)
        .unwrap_or_else(|| Arc::new(cache::CacheStructure::new(digest)))
    });
    if hit {
      logger.info(format!("cache: unchanged graph (digest {digest_ms:.3} ms)"));
    } else if active || first_compilation {
      logger.info(format!(
        "cache: full run ({reason}; digest {digest_ms:.3} ms)"
      ));
    }
    let diagnostics = compilation.diagnostics().len();
    let settings = self.full_impl(compilation, structure.as_deref()).await?;
    let start = logger.time("ensure max size fit");
    self.ensure_max_size_fit(compilation, &settings).await?;
    logger.time_end(start);
    if compilation.diagnostics().len() == diagnostics {
      if std::env::var_os("RSPACK_SPLIT_CHUNKS_STRUCTURE_MEMORY").as_deref()
        == Some(std::ffi::OsStr::new("1"))
        && let Some(structure) = &structure
      {
        logger.info(format!(
          "structure cache: retained={} bytes",
          structure.logical_bytes()
        ));
      }
      *self.cache_structure.lock().expect("cache structure lock") = structure;
    }
    Ok(())
  }

  async fn full_impl(
    &self,
    compilation: &mut Compilation,
    structure: Option<&cache::CacheStructure>,
  ) -> Result<FxHashMap<ChunkUkey, MaxSizeSetting>> {
    let logger = compilation.get_logger(self.name());
    let start = logger.time("prepare module data");

    let mut all_modules = compilation
      .get_module_graph()
      .modules_keys()
      .copied()
      .collect::<Vec<_>>();
    // Sort modules to ensure deterministic processing order.
    // Use the precomputed identifier hash first to avoid repeated long string comparisons.
    all_modules.sort_unstable_by_key(|module| (module.precomputed_hash(), *module));

    let module_sizes = get_module_sizes(all_modules.par_iter().copied(), compilation);
    let size_check_skipped = size_check_skipped();
    let fallback = if let Some(structure) = structure {
      if !size_check_skipped
        && !cache::exact_size_arithmetic(
          &module_sizes,
          compilation.build_chunk_graph_artifact.chunk_by_ukey.len(),
        )
      {
        Some(cache::PhaseOutcome::SizeSafety)
      } else if !structure.order_safe(self, &all_modules, compilation) {
        Some(cache::PhaseOutcome::Ordering)
      } else {
        None
      }
    } else {
      Some(cache::PhaseOutcome::Disabled)
    };
    let structure = if fallback.is_none() { structure } else { None };
    let mut module_chunks = Self::get_module_chunks(&all_modules, compilation);
    let module_indices = all_modules
      .iter()
      .enumerate()
      .map(|(index, module)| (*module, index))
      .collect::<IdentifierMap<_>>();
    logger.time_end(start);

    let chunk_index_map: FxHashMap<ChunkUkey, u32> = {
      let mut ordered_chunks = compilation
        .build_chunk_graph_artifact
        .chunk_by_ukey
        .values()
        .collect::<Vec<_>>();

      ordered_chunks.sort_by_cached_key(|chunk| {
        // sort by (group.index, chunk index in group)
        let group = chunk
          .groups()
          .iter()
          .map(|group| {
            compilation
              .build_chunk_graph_artifact
              .chunk_group_by_ukey
              .expect_get(group)
          })
          .min_by(|group1, group2| group1.index.cmp(&group2.index))
          .expect("chunk should have at least one group");
        let chunk_index = group
          .chunks
          .iter()
          .position(|c| *c == chunk.ukey())
          .expect("chunk should be in its group");
        (group.index, chunk_index)
      });

      ordered_chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
          (
            chunk.ukey(),
            u32::try_from(index + 1).expect("chunk index should fit in u32"),
          )
        })
        .collect()
    };

    let start = logger.time("prepare cache groups");
    let mut priority_cache_groups = vec![];

    for (priority, cache_groups) in &self
      .cache_groups
      .iter()
      .enumerate()
      .map(|v| IndexedCacheGroup {
        cache_group_index: u32::try_from(v.0).expect("cache group index should fit in u32"),
        cache_group: v.1,
      })
      .sorted_by(|a, b| match b.compare_by_priority(a) {
        Ordering::Equal => a.compare_by_index(b),
        v => v,
      })
      .chunk_by(|v| v.cache_group.priority)
    {
      priority_cache_groups.push((priority, cache_groups.into_iter().collect::<Vec<_>>()));
    }

    let mut max_size_setting_map: FxHashMap<ChunkUkey, MaxSizeSetting> = Default::default();
    let mut removed_module_chunks: IdentifierMap<FxHashSet<ChunkUkey>> = IdentifierMap::default();

    // Each priority uses the remaining original module-chunk edges. Destinations
    // created by earlier splits never become inputs to candidate enumeration.
    let mut combinator = module_group::Combinator::default();
    logger.time_end(start);

    let start = logger.time("process cache groups");
    let stages = priority_cache_groups
      .iter()
      .map(|(_, groups)| groups.as_slice())
      .collect::<Vec<_>>();
    let native_matches =
      self.prepare_native_cache_group_matches(&all_modules, &stages, compilation);
    let priority_len = priority_cache_groups.len();
    let mut js_may_have_run = false;
    let mut phase_chunk_keys = cache::PhaseChunkKeys::default();
    for (index, ((_, cache_groups), native_matches)) in priority_cache_groups
      .into_iter()
      .zip(native_matches)
      .enumerate()
    {
      for (module, removed) in removed_module_chunks.drain() {
        let remaining = &mut module_chunks[module_indices[&module]];
        for chunk in removed {
          remaining.remove(&chunk);
        }
      }
      // Named groups also consult the remaining original placements while selecting winners at
      // this priority. Consume placements immediately so their extra deduplication cannot move
      // modules out of a previously claimed original destination. Anonymous-only priorities keep
      // their existing batched removal path until the next priority.
      let has_lower_priority = index != priority_len - 1;
      let has_named_groups = cache_groups.iter().any(|indexed| {
        !matches!(&indexed.cache_group.name, ChunkNameGetter::Disabled)
          || self.name_batch_getters.as_deref().is_some_and(|getters| {
            getters
              .get(indexed.cache_group_index as usize)
              .is_some_and(Option::is_some)
          })
      });
      let available_module_chunks = &module_chunks;
      let key_start = Instant::now();
      let phase_digest = structure.map(|structure| {
        self.phase_digest(
          structure.digest,
          index,
          compilation,
          &all_modules,
          available_module_chunks,
          &chunk_index_map,
          &phase_chunk_keys,
        )
      });
      let phase_key_ms = key_start.elapsed().as_secs_f64() * 1000.0;
      if cache::verification_enabled()
        && let Some(digest) = phase_digest
      {
        logger.info(format!("structure key: phase={index} digest={digest:032x}"));
      }
      let can_call_js = !self.can_prepare_native_cache_groups(&cache_groups);
      let shape_guarded = js_may_have_run && can_call_js;
      let mut cached = structure
        .zip(phase_digest)
        .and_then(|(structure, digest)| structure.phase(index, digest))
        .filter(|_| !shape_guarded);
      let validated_reads = cached.as_ref().map_or(0, |phase| phase.size_reads.len());
      let validation_start = Instant::now();
      let tracked_read_changed = cached
        .as_ref()
        .is_some_and(|phase| !phase.validate_size_reads(compilation));
      let validation_ms = if validated_reads == 0 {
        0.0
      } else {
        validation_start.elapsed().as_secs_f64() * 1000.0
      };
      if tracked_read_changed {
        structure
          .expect("cached phase should have an owner")
          .invalidate(index);
        cached = None;
      }
      let mut fresh = None;
      if cached.is_none() || cache::verification_enabled() {
        // Only JavaScript preparation can change module shapes after the initial check.
        js_may_have_run |= can_call_js;
        let build_start = Instant::now();
        let reads =
          structure.map(|_| rspack_core::ModuleReadSession::new(compilation.compiler_id()));
        // Precompute once for this priority, then reuse the prepared combinations
        // throughout candidate preparation and selection.
        let previous = std::mem::take(&mut combinator);
        rayon::spawn(move || drop(previous));
        let intersection_settings = |used_exports| {
          if self.dedup_depth == 0 {
            return None;
          }
          let intersection_cache_groups = cache_groups
            .iter()
            .filter(|indexed_cache_group| {
              let cache_group = indexed_cache_group.cache_group;
              let has_name_batch_getter =
                self.name_batch_getters.as_deref().is_some_and(|getters| {
                  getters
                    .get(indexed_cache_group.cache_group_index as usize)
                    .is_some_and(Option::is_some)
                });
              cache_group.used_exports == used_exports
                && module_group::cache_group_uses_intersections(cache_group, has_name_batch_getter)
            })
            .collect::<Vec<_>>();
          let min_chunks = intersection_cache_groups
            .iter()
            .map(|indexed_cache_group| (indexed_cache_group.cache_group.min_chunks as usize).max(1))
            .min();
          min_chunks.map(|min_chunks| {
            (
              min_chunks,
              intersection_cache_groups
                .into_iter()
                .map(|group| group.cache_group)
                .collect(),
            )
          })
        };
        let non_used_exports_intersection_settings = intersection_settings(false);
        let used_exports_intersection_settings = intersection_settings(true);
        let non_used_exports_min_chunks = cache_groups
          .iter()
          .filter(|cache_group| !cache_group.cache_group.used_exports)
          .map(|cache_group| cache_group.cache_group.min_chunks as usize)
          .min();

        if let Some(min_chunks) = non_used_exports_min_chunks {
          combinator.prepare_group_by_chunks(
            &all_modules,
            available_module_chunks,
            &chunk_index_map,
            min_chunks,
            module_group::IntersectionPreparation {
              dedup_depth: self.dedup_depth,
              settings: non_used_exports_intersection_settings,
              module_sizes: &module_sizes,
              compilation,
              unpruned: structure.is_some(),
            },
          );
        }

        if cache_groups
          .iter()
          .any(|cache_group| cache_group.cache_group.used_exports)
        {
          combinator.prepare_group_by_used_exports(
            &all_modules,
            &compilation.exports_info_artifact,
            &compilation.build_chunk_graph_artifact.chunk_by_ukey,
            available_module_chunks,
            &chunk_index_map,
            module_group::IntersectionPreparation {
              dedup_depth: self.dedup_depth,
              settings: used_exports_intersection_settings,
              module_sizes: &module_sizes,
              compilation,
              unpruned: structure.is_some(),
            },
          );
        }

        let pruning = if structure.is_some() {
          combinator.snapshot_pruning(
            &all_modules,
            &cache_groups,
            self.name_batch_getters.as_deref(),
            &module_sizes,
            compilation,
          )
        } else {
          [None, None]
        };
        let candidates = self
          .prepare_module_group_candidates(
            &combinator,
            &all_modules,
            cache_groups,
            native_matches,
            compilation,
            available_module_chunks,
            &chunk_index_map,
          )
          .await?;
        let build_ms = build_start.elapsed().as_secs_f64() * 1000.0;
        let reads = reads.map_or_else(
          rspack_core::ModuleReadSet::default,
          rspack_core::ModuleReadSession::finish,
        );
        fresh = Some((candidates, pruning, build_ms, reads));
      }
      if fresh
        .as_ref()
        .is_some_and(|(_, _, _, reads)| reads.untrackable)
      {
        if let Some(structure) = structure {
          structure.invalidate(index);
        }
        cached = None;
      }
      let (recorded_reads, recorded_calls) = fresh.as_ref().map_or_else(
        || {
          cached.as_ref().map_or((0, 0), |phase| {
            (phase.size_reads.len(), phase.size_read_calls)
          })
        },
        |(_, _, _, reads)| (reads.sizes.len(), reads.size_calls),
      );
      let mut outcome = cache::PhaseOutcome::Hit;
      let mut clone_ms = 0.0;
      let build_ms = fresh.as_ref().map_or(0.0, |(_, _, build_ms, _)| *build_ms);
      let mut module_group_map = if let Some(cached) = cached {
        if let Some((candidates, pruning, build_ms, _)) = &mut fresh {
          cached.assert_matches(index, candidates, pruning, &module_sizes);
          logger.info(format!("structure verification: phase={index} matched key={phase_key_ms:.3} build={build_ms:.3} ms"));
        }
        let clone_start = Instant::now();
        let candidates = cached.clone_candidates();
        clone_ms = clone_start.elapsed().as_secs_f64() * 1000.0;
        cached.restore(candidates, self, &module_sizes, compilation)
      } else {
        let (candidates, pruning, _, reads) = fresh.expect("fresh candidates should exist");
        if let Some((structure, digest)) = structure.zip(phase_digest) {
          if reads.untrackable {
            outcome = cache::PhaseOutcome::UntrackableRead;
            cache::PreparedPhase::into_current_map(
              candidates,
              &pruning,
              self,
              &module_sizes,
              compilation,
            )
          } else if candidates
            .iter()
            .all(|candidate| candidate.group.deterministic_chunk_choice(compilation))
          {
            let snapshot = cache::PreparedPhase::capture(digest, &candidates, pruning, reads);
            let map = snapshot.restore(candidates, self, &module_sizes, compilation);
            structure.insert(index, snapshot);
            outcome = if shape_guarded {
              cache::PhaseOutcome::ShapeGuard
            } else if tracked_read_changed {
              cache::PhaseOutcome::TrackedReadChanged
            } else {
              cache::PhaseOutcome::DigestMiss
            };
            map
          } else {
            outcome = cache::PhaseOutcome::ReuseAmbiguity;
            cache::PreparedPhase::into_current_map(
              candidates,
              &pruning,
              self,
              &module_sizes,
              compilation,
            )
          }
        } else {
          outcome = fallback.expect("disabled structure should have a reason");
          cache::PreparedPhase::into_current_map(
            candidates,
            &pruning,
            self,
            &module_sizes,
            compilation,
          )
        }
      };
      if !matches!(outcome, cache::PhaseOutcome::Disabled) {
        logger.info(format!("structure reads: phase={index} recorded={recorded_reads} calls={recorded_calls} validated={validated_reads} validate={validation_ms:.6} ms"));
      }
      tracing::trace!("prepared module_group_map {:#?}", module_group_map);

      module_group_map
        .par_iter_mut()
        .for_each(|(_, module_group)| module_group.prepare_modules_for_sizes_and_compare());
      self.ensure_min_size_fit(&mut module_group_map, &module_sizes);

      let mut phase_external_selection = false;
      while let Some((module_group_key, mut module_group)) =
        self.find_best_module_group(&mut module_group_map)
      {
        tracing::trace!(
          "ModuleGroup({}) wins, {:?} `ModuleGroup` remains",
          module_group_key,
          module_group_map.len(),
        );
        let cache_group = module_group.get_cache_group(&self.cache_groups);

        let mut is_reuse_existing_chunk = false;
        let mut is_reuse_existing_chunk_with_all_modules = false;
        let new_chunk = self.get_corresponding_chunk(
          compilation,
          &mut module_group,
          &mut is_reuse_existing_chunk,
          &mut is_reuse_existing_chunk_with_all_modules,
        );
        if !is_reuse_existing_chunk {
          phase_chunk_keys.record_created(new_chunk);
        }

        tracing::trace!(
          "{module_group_key}, get Chunk {:?} with is_reuse_existing_chunk: {is_reuse_existing_chunk:?} and {is_reuse_existing_chunk_with_all_modules:?}",
          compilation
            .build_chunk_graph_artifact
            .chunk_by_ukey
            .expect_get(&new_chunk)
            .chunk_reason()
        );

        if is_reuse_existing_chunk {
          // The chunk is not new but created in code splitting. We need remove `new_chunk` since we would remove
          // modules in this `Chunk/ModuleGroup` from other chunks. Other chunks is stored in `ModuleGroup.chunks`.
          module_group.remove_group_chunk(&new_chunk);
        }

        // If the module group size exceeds enforceSizeThreshold, skip request and remaining-size constraints.
        // https://webpack.js.org/plugins/split-chunks-plugin/#splitchunksenforcesizethreshold
        let enforce_size_exceeded = cache_group
          .enforce_size_threshold
          .values()
          .any(|size| *size > 0.0)
          && !module_group
            .get_sizes(&module_sizes)
            .smaller_than(&cache_group.enforce_size_threshold);

        let mut used_chunks = Cow::Borrowed(&module_group.chunks);

        if !enforce_size_exceeded {
          self.ensure_max_request_fit(compilation, cache_group, &mut used_chunks);
        }

        // A named group can remove additional copies from chunks selected by its other modules.
        // Validate each module against its own selected sources before committing any placements;
        // max-request pruning must not let an unrelated source qualify a module for extraction.
        let mut used_chunks = used_chunks;
        let (mut placed_module_chunks, external_selection) = self
          .get_module_chunks_to_move(
            &module_group,
            new_chunk,
            &used_chunks,
            &module_chunks,
            &module_indices,
            compilation,
          )
          .await?;
        // Selection runs live on hits too. An external chunk condition can call JavaScript
        // and change module objects before a later phase prepares or restores candidates.
        phase_external_selection |= external_selection;
        js_may_have_run |= external_selection;
        {
          let chunk_graph = &compilation.build_chunk_graph_artifact.chunk_graph;
          if is_reuse_existing_chunk {
            // A module already in the reused destination does not need to move, but that original
            // placement still belongs to the winning group and must be unavailable to competing
            // groups at this and lower priorities.
            for module in module_group
              .modules
              .iter()
              .filter(|module| chunk_graph.is_module_in_chunk(module, new_chunk))
            {
              placed_module_chunks.insert_chunk(*module, new_chunk);
            }
          }
        }

        let modules_without_placement = match &placed_module_chunks {
          ModuleChunkMap::Shared { modules, chunks }
            if module_group.uses_shared_module_chunks() =>
          {
            debug_assert!(modules.is_subset(&module_group.modules));
            debug_assert!(
              chunks.is_subset(
                module_group
                  .shared_module_chunks()
                  .expect("should have shared module chunks")
              )
            );
            if chunks.len() < cache_group.min_chunks as usize {
              module_group.modules.iter().copied().collect::<Vec<_>>()
            } else if modules.len() == module_group.modules.len() {
              Vec::new()
            } else {
              module_group
                .modules
                .difference(modules)
                .copied()
                .collect::<Vec<_>>()
            }
          }
          _ => module_group
            .modules
            .iter()
            .filter(|module| {
              let Some(placed_chunks) = placed_module_chunks.get(module) else {
                return true;
              };
              let Some(selected_chunks) = module_group.get_module_chunks(module) else {
                return true;
              };
              placed_chunks
                .iter()
                .filter(|chunk| selected_chunks.contains(*chunk))
                .count()
                < cache_group.min_chunks as usize
            })
            .copied()
            .collect::<Vec<_>>(),
        };
        if !modules_without_placement.is_empty() {
          // End the borrow of `module_group.chunks` only on the slow path that mutates the group.
          // The common path can keep using the original set without cloning it.
          let used_chunks_owned = used_chunks.into_owned();
          for module in modules_without_placement {
            module_group.remove_module(module);
          }

          // Max-request pruning and chunk conditions can change the module subset, so size checks
          // performed before selecting `used_chunks` are no longer sufficient.
          if min_size::remove_min_size_violating_modules(
            &module_group_key,
            &mut module_group,
            cache_group,
            &module_sizes,
          ) {
            tracing::trace!(
              "ModuleGroup({module_group_key}) is skipped after selecting its actual placements because it violates min_size {:#?}",
              cache_group.min_size,
            );
            continue;
          }

          placed_module_chunks.retain_modules(&module_group.modules);
          used_chunks = Cow::Owned(used_chunks_owned);
        }

        // Keep a reused destination in `placed_module_chunks` for ownership cleanup, even when the
        // cache group's chunk filter did not select it. Such an excluded destination must not count
        // towards `minChunks` or the source chunks split into the destination.
        let selected_placement_chunks = match &placed_module_chunks {
          ModuleChunkMap::Shared { chunks, .. } => Cow::Borrowed(chunks),
          ModuleChunkMap::ByModule(module_chunks) => Cow::Owned(
            module_chunks
              .iter()
              .flat_map(|(module, placed_chunks)| {
                let selected_chunks = module_group
                  .get_module_chunks(module)
                  .expect("should have selected module chunks");
                placed_chunks
                  .iter()
                  .filter(|chunk| selected_chunks.contains(*chunk))
                  .copied()
              })
              .collect::<FxHashSet<_>>(),
          ),
        };
        let removed_unused_sources = used_chunks
          .iter()
          .any(|chunk| !selected_placement_chunks.contains(chunk));
        if removed_unused_sources {
          used_chunks
            .to_mut()
            .retain(|chunk| selected_placement_chunks.contains(chunk));
        }

        let selected_chunk_count = selected_placement_chunks.len();
        drop(selected_placement_chunks);

        if selected_chunk_count < cache_group.min_chunks as usize {
          tracing::trace!(
            "ModuleGroup({module_group_key}) is skipped. Reason: selected_placement_chunks.len()({:?}) < cache_group.min_chunks({:?})",
            selected_chunk_count,
            cache_group.min_chunks
          );
          continue;
        }

        if removed_unused_sources
          && let ModuleChunkMap::ByModule(placements) = &mut placed_module_chunks
        {
          // Removing an ineligible module can also remove the only reason to connect one of the
          // source chunks to this destination. Keep any extra copy in that source chunk.
          for chunks in placements.values_mut() {
            chunks.retain(|chunk| *chunk == new_chunk || used_chunks.contains(chunk));
          }
        }

        if !Self::check_min_size_reduction_for_module_chunks(
          &placed_module_chunks,
          new_chunk,
          &module_sizes,
          &cache_group.min_size_reduction,
        ) {
          tracing::trace!(
            "ModuleGroup({module_group_key}) is skipped after selecting its actual placements because it violates min_size_reduction {:#?}",
            cache_group.min_size_reduction,
          );
          continue;
        }

        if !enforce_size_exceeded
          && used_chunks.len() == 1
          && cache_group
            .min_remaining_size
            .values()
            .any(|size| *size > 0.0)
        {
          let source_chunk = *used_chunks
            .iter()
            .next()
            .expect("should have one source chunk");
          let violating_source_types = Self::get_min_remaining_size_violations(
            &placed_module_chunks,
            source_chunk,
            compilation,
            &module_sizes,
            &cache_group.min_remaining_size,
          );
          if !violating_source_types.is_empty() {
            let old_modules_size = module_group.modules.len();
            let _ = module_group.get_sizes(&module_sizes);
            let violating_modules =
              module_group.get_source_types_modules(&violating_source_types, &module_sizes);
            module_group.remove_modules(violating_modules);
            // Retry only when removing source types made progress. In particular, extracting CSS
            // can leave a tiny JavaScript module without any JavaScript in the candidate to remove.
            if !module_group.modules.is_empty() && module_group.modules.len() != old_modules_size {
              module_group.rebuild_chunks();
              let _ = module_group.get_sizes(&module_sizes);
              module_group_map.insert(module_group_key, module_group);
            }
            continue;
          }
        }

        if module_group.placement_changed()
          && !residual::placement_preserves_copies(
            &placed_module_chunks,
            &used_chunks,
            new_chunk,
            compilation,
          )
        {
          continue;
        }

        // Only mutate metadata on an existing destination after the winning group has passed all
        // checks. A group skipped after max-request pruning must not leave cache-group metadata on
        // a chunk it did not actually use.
        self.apply_split_metadata(
          new_chunk,
          cache_group,
          module_group.chunk_name.as_deref(),
          compilation,
          &mut max_size_setting_map,
        );

        self.move_modules_to_new_chunk_and_remove_from_old_chunks(
          &placed_module_chunks,
          new_chunk,
          compilation,
        );

        self.split_from_original_chunks(&used_chunks, new_chunk, compilation);

        self.remove_all_modules_from_other_module_groups(
          &placed_module_chunks,
          &mut module_group_map,
          &module_sizes,
        );

        if has_named_groups && (has_lower_priority || !module_group_map.is_empty()) {
          match &placed_module_chunks {
            ModuleChunkMap::Shared { modules, chunks } => {
              for module in modules {
                let remaining = &mut module_chunks[module_indices[module]];
                for chunk in chunks {
                  remaining.remove(chunk);
                }
              }
            }
            ModuleChunkMap::ByModule(placements) => {
              for (module, chunks) in placements {
                let remaining = &mut module_chunks[module_indices[module]];
                for chunk in chunks {
                  remaining.remove(chunk);
                }
              }
            }
          }
        } else if has_lower_priority {
          match &placed_module_chunks {
            ModuleChunkMap::Shared { modules, chunks } => {
              for module in modules {
                removed_module_chunks
                  .entry(*module)
                  .or_default()
                  .extend(chunks.iter().copied());
              }
            }
            ModuleChunkMap::ByModule(placements) => {
              for (module, chunks) in placements {
                removed_module_chunks
                  .entry(*module)
                  .or_default()
                  .extend(chunks.iter().copied());
              }
            }
          }
        }
      }
      if !matches!(outcome, cache::PhaseOutcome::Disabled) {
        logger.info(format!("structure cache: phase={index} outcome={} js={can_call_js} external_selection={phase_external_selection} key={phase_key_ms:.3} build={build_ms:.3} clone={clone_ms:.3} ms size_check_skipped={size_check_skipped}", outcome.label()));
      }
    }
    logger.time_end(start);

    rayon::spawn(move || drop(combinator));
    Ok(max_size_setting_map)
  }
}

impl Debug for SplitChunksPlugin {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("SplitChunksPlugin").finish()
  }
}

#[plugin_hook(CompilationOptimizeChunks for SplitChunksPlugin, stage = Compilation::OPTIMIZE_CHUNKS_STAGE_ADVANCED)]
async fn optimize_chunks(&self, compilation: &mut Compilation) -> Result<Option<bool>> {
  self.inner_impl(compilation).await?;
  Ok(None)
}

impl Plugin for SplitChunksPlugin {
  fn name(&self) -> &'static str {
    "rspack.SplitChunksPlugin"
  }

  fn apply(&self, ctx: &mut rspack_core::ApplyContext<'_>) -> Result<()> {
    ctx
      .compilation_hooks
      .optimize_chunks
      .tap(optimize_chunks::new(self));
    Ok(())
  }
}

#[derive(Debug)]
struct MaxSizeSetting {
  pub min_size: SplitChunkSizes,
  pub max_async_size: SplitChunkSizes,
  pub max_initial_size: SplitChunkSizes,
  pub automatic_name_delimiter: String,
}
