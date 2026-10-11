use std::sync::{
  Arc,
  atomic::{AtomicU64, Ordering},
};

use rspack_collections::{Identifiable, IdentifierDashMap};
use rspack_error::{Result, ToStringResultToRspackResultExt};

use crate::{
  BoxModule, BuildModuleGraphArtifact, FileSystemInfo, ModuleGraph, ModuleIdentifier, ModuleRef,
  NeedBuildContext, ValueCacheVersions,
  new_cache::{CacheFacade, CacheValue},
};

/// Cache for completed module builds, validated by each module's `need_build` implementation.
///
/// Memory entries share the built module with the graph. Persistent entries
/// encode the same module directly, including its dependencies and build metadata.
#[derive(Debug, Clone)]
pub(crate) struct ModuleBuildCache {
  cache: CacheFacade,
  restore_enabled: bool,
  pending: Arc<IdentifierDashMap<u64>>,
  pub(crate) counters: Arc<RouteCounters>,
}

impl ModuleBuildCache {
  pub(crate) fn new(cache: CacheFacade, restore_enabled: bool) -> Self {
    Self {
      cache,
      restore_enabled,
      pending: Default::default(),
      counters: Default::default(),
    }
  }

  /// Defers publishing a built module until the build-module-graph phase has
  /// completed, so make-stage mutations are included in the cache entry.
  pub(crate) fn mark_pending(&self, module_identifier: ModuleIdentifier, build_start_time: u64) {
    self.pending.insert(module_identifier, build_start_time);
  }

  pub(crate) async fn restore(
    &self,
    module: &BoxModule,
    file_system_info: &FileSystemInfo,
    value_cache_versions: &ValueCacheVersions,
  ) -> Result<Option<ModuleRef>> {
    if !self.restore_enabled {
      return Ok(None);
    }

    let identifier = module.identifier();
    let Some(result) = self.cache.get::<ModuleRef>(identifier.as_str(), None) else {
      return Ok(None);
    };
    if result
      .need_build(&NeedBuildContext::new(
        file_system_info,
        value_cache_versions,
      ))
      .await?
    {
      return Ok(None);
    }

    result.reset_for_compilation(module.factory_meta());
    Ok(Some(result.as_arc().as_ref().clone()))
  }

  /// Stores modules built during this phase from the final module graph.
  ///
  /// Cache preparation and cache-entry construction are parallel. Modules,
  /// dependencies and blocks retain shared identity.
  pub(crate) async fn store_pending(
    &self,
    artifact: &mut BuildModuleGraphArtifact,
    file_system_info: &FileSystemInfo,
  ) -> Result<()> {
    let pending = self
      .pending
      .iter()
      .map(|entry| (*entry.key(), *entry.value()))
      .collect::<Vec<_>>();
    self.pending.clear();

    let module_graph = artifact.get_module_graph();
    let prepared_modules = rspack_parallel::scope::<_, Result<_>>(|token| {
      for (module_identifier, build_start_time) in pending {
        // SAFETY: the scope is awaited before the module graph is mutated.
        let task = unsafe { token.used((module_graph, file_system_info)) };
        task.spawn(move |(module_graph, file_system_info)| async move {
          let Some(module) = module_graph.module_by_identifier(&module_identifier) else {
            return Ok(None);
          };
          module
            .prepare_for_cache(file_system_info, build_start_time)
            .await?;
          Ok(Some(module_identifier))
        });
      }
    })
    .await
    .into_iter()
    .map(|result| result.to_rspack_result().and_then(|result| result))
    .collect::<Result<Vec<_>>>()?;

    let module_identifiers = prepared_modules
      .into_iter()
      .flatten()
      .filter_map(|module_identifier| {
        let module = artifact
          .get_module_graph()
          .module_by_identifier(&module_identifier)?;
        module.freeze_build_info();
        Some(module_identifier)
      })
      .collect::<Vec<_>>();

    let module_graph = artifact.get_module_graph();
    let cache_entries = rspack_parallel::scope::<_, Result<_>>(|token| {
      for module_identifier in module_identifiers {
        // SAFETY: the scope is awaited before the cache entries are published.
        let task = unsafe { token.used(module_graph) };
        task.spawn(move |module_graph| async move {
          Ok((
            module_identifier,
            create_cache_entry(module_graph, module_identifier),
          ))
        });
      }
    })
    .await
    .into_iter()
    .map(|result| result.to_rspack_result().and_then(|result| result))
    .collect::<Result<Vec<_>>>()?;

    for (module_identifier, entry) in cache_entries {
      self
        .cache
        .store(module_identifier.as_str(), None, CacheValue::new(entry));
    }
    Ok(())
  }
}

fn create_cache_entry(
  module_graph: &ModuleGraph,
  module_identifier: ModuleIdentifier,
) -> ModuleRef {
  let source_module = module_graph
    .module_by_identifier(&module_identifier)
    .expect("pending module should exist in the final module graph");
  source_module.clone()
}

#[derive(Debug, Default)]
pub(crate) struct RouteCounters {
  pub(crate) factorize: AtomicU64,
  pub(crate) lookups: AtomicU64,
  pub(crate) hits: AtomicU64,
  pub(crate) owner_miss: AtomicU64,
  pub(crate) group_miss: AtomicU64,
  pub(crate) target_absent: AtomicU64,
  pub(crate) target_unsupported: AtomicU64,
  pub(crate) target_invalid: AtomicU64,
  pub(crate) target_decodes: AtomicU64,
  pub(crate) builds: AtomicU64,
  pub(crate) records: AtomicU64,
  pub(crate) route_owners: AtomicU64,
  pub(crate) route_live_bytes: AtomicU64,
}

impl RouteCounters {
  pub(crate) fn print(&self, artifact: &BuildModuleGraphArtifact) {
    if std::env::var_os("RSPACK_ROUTE_COUNTERS").is_none() {
      return;
    }
    let graph = artifact.get_module_graph();
    eprintln!(
      "ROUTE_D_COUNTERS factorize={} lookups={} hits={} owner_miss={} group_miss={} target_absent={} target_unsupported={} target_invalid={} target_decodes={} builds={} records={} modules={} dependencies={} connections={} route_owners={} route_live_bytes={}",
      self.factorize.load(Ordering::Relaxed),
      self.lookups.load(Ordering::Relaxed),
      self.hits.load(Ordering::Relaxed),
      self.owner_miss.load(Ordering::Relaxed),
      self.group_miss.load(Ordering::Relaxed),
      self.target_absent.load(Ordering::Relaxed),
      self.target_unsupported.load(Ordering::Relaxed),
      self.target_invalid.load(Ordering::Relaxed),
      self.target_decodes.load(Ordering::Relaxed),
      self.builds.load(Ordering::Relaxed),
      self.records.load(Ordering::Relaxed),
      graph.modules().count(),
      graph.dependencies().count(),
      graph
        .modules()
        .map(|(id, _)| graph.get_outgoing_connections(id).count())
        .sum::<usize>()
        + graph
          .dependencies()
          .filter(|(id, _)| graph
            .connection_by_dependency_id(id)
            .is_some_and(|c| c.original_module_identifier.is_none()))
          .count(),
      self.route_owners.load(Ordering::Relaxed),
      self.route_live_bytes.load(Ordering::Relaxed)
    );
  }
}
