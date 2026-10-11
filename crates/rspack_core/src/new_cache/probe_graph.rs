//! Fork-only bulk graph recovery measurement. Plugin and configuration eligibility is unchecked.
use std::{
  ops::{Deref, DerefMut},
  sync::{
    Arc, LazyLock,
    atomic::{AtomicU64, Ordering},
  },
  time::Instant,
};

use rayon::prelude::*;
use rspack_cacheable::{cacheable, utils::OwnedOrRef};
use rspack_collections::Identifiable;
use rspack_error::{Result, error};
use rspack_parallel::TryFutureConsumer;
use rspack_paths::InternedPathSet;

use super::{CacheFacade, CacheKey, FileCacheStrategy, Snapshot, SnapshotValidationResult};
use crate::{
  ArtifactExt, AsyncDependenciesBlockIdentifier, BuildModuleGraphArtifact, Compilation,
  DependenciesBlock, Dependency, DependencyId, DependencyParents, FactorizeInfo,
  ModuleGraphConnection, ModuleGraphModule, ModuleRef,
  cache::CacheCodec,
  incremental::{Incremental, IncrementalPasses},
  utils::ResourceId,
};

const INDEX: &str = "probe_graph_index";
const SNAPSHOT: &str = "probe_graph_snapshot";
const CHUNK: usize = 256;
const PACKET_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
// Aggregate CPU durations may exceed elapsed time across Rayon workers. Chunk
// elapsed durations separately expose the read/decode barrier critical path.
static TIMING: LazyLock<bool> =
  LazyLock::new(|| std::env::var_os("RSPACK_PROBE_GRAPH_TIMERS").is_some());
static METRICS: [AtomicU64; 10] = [const { AtomicU64::new(0) }; 10];
pub(crate) fn timer_start() -> Option<Instant> {
  (*TIMING).then(Instant::now)
}
pub(crate) fn timer_add(slot: usize, start: Option<Instant>) {
  if let Some(start) = start {
    METRICS[slot].fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
  }
}
pub(crate) fn count_add(slot: usize, value: usize) {
  if *TIMING {
    METRICS[slot].fetch_add(value as u64, Ordering::Relaxed);
  }
}
pub(crate) fn store_metrics() {
  if *TIMING {
    let metrics = METRICS.each_ref().map(|v| v.swap(0, Ordering::Relaxed));
    eprintln!(
      "GRAPH_STORE_TIMERS topology_encode_cpu_ms={} topology_bytes={} topology_records={}",
      metrics[2] as f64 / 1e6,
      metrics[5],
      metrics[7]
    );
  }
}
fn millis(start: Instant) -> f64 {
  start.elapsed().as_secs_f64() * 1000.0
}

// This cell shares the graph only after done. No second topology owner is copied.
// Rebuild is deliberately excluded from the prototype's supported workflow.
#[derive(Debug)]
pub struct GraphCell(Option<Arc<BuildModuleGraphArtifact>>);
impl From<BuildModuleGraphArtifact> for GraphCell {
  fn from(value: BuildModuleGraphArtifact) -> Self {
    Self(Some(Arc::new(value)))
  }
}
impl GraphCell {
  pub fn try_read(&self) -> Option<&BuildModuleGraphArtifact> {
    self.0.as_deref()
  }
  pub fn try_write(&mut self) -> Option<&mut BuildModuleGraphArtifact> {
    self.0.as_mut().and_then(Arc::get_mut)
  }
  pub fn is_stolen(&self) -> bool {
    self.0.is_none()
  }
  pub fn steal(&mut self) -> BuildModuleGraphArtifact {
    Arc::try_unwrap(self.0.take().expect("graph must exist"))
      .expect("graph must not be shared during compilation")
  }
  fn share(&self) -> Arc<BuildModuleGraphArtifact> {
    Arc::clone(self.0.as_ref().expect("graph must exist"))
  }
}
impl Deref for GraphCell {
  type Target = BuildModuleGraphArtifact;
  fn deref(&self) -> &Self::Target {
    self.try_read().expect("graph must exist")
  }
}
impl DerefMut for GraphCell {
  fn deref_mut(&mut self) -> &mut Self::Target {
    self.try_write().expect("idle graph must not be mutated")
  }
}
impl ArtifactExt for GraphCell {
  const PASS: IncrementalPasses = BuildModuleGraphArtifact::PASS;
  fn should_recover(incremental: &Incremental) -> bool {
    BuildModuleGraphArtifact::should_recover(incremental)
  }
  fn recover(incremental: &Incremental, new: &mut Self, old: &mut Self) {
    BuildModuleGraphArtifact::recover(incremental, new, old);
  }
}

#[derive(Debug)]
pub(crate) struct PendingGraph {
  graph: Arc<BuildModuleGraphArtifact>,
  snapshot: Snapshot,
}

// Dependency and block objects already belong to the module entry. Only IDs,
// parents, factorization data and edges are stored here.
#[cacheable]
struct Node<'a> {
  mgm: OwnedOrRef<'a, ModuleGraphModule>,
  dependencies: Vec<(
    DependencyId,
    Option<AsyncDependenciesBlockIdentifier>,
    Option<OwnedOrRef<'a, FactorizeInfo>>,
  )>,
  connections: Vec<OwnedOrRef<'a, ModuleGraphConnection>>,
  lazy_info: Option<OwnedOrRef<'a, crate::compilation::build_module_graph::LazyDependencies>>,
}

fn key(id: &str) -> CacheKey {
  CacheKey::from(format!("probe_graph_node|{id}"))
}

fn topology<'a>(graph: &'a BuildModuleGraphArtifact, id: &crate::ModuleIdentifier) -> Node<'a> {
  let mg = graph.get_module_graph();
  let mgm = mg
    .module_graph_module_by_identifier(id)
    .expect("graph module must exist");
  Node {
    mgm: mgm.into(),
    dependencies: mgm
      .all_dependencies()
      .iter()
      .map(|dep| {
        (
          *dep,
          mg.get_parent_block(dep).copied(),
          graph
            .factorization_artifact
            .get_by_owner(dep)
            .map(Into::into),
        )
      })
      .collect(),
    connections: mgm
      .outgoing_connections()
      .iter()
      .map(|con| {
        mg.connection_by_id(con)
          .expect("connection must exist")
          .into()
      })
      .collect(),
    lazy_info: graph
      .module_to_lazy_make
      .get_lazy_dependencies(id)
      .map(Into::into),
  }
}

impl PendingGraph {
  pub(crate) fn write_bounded(
    &self,
    mut commit: impl FnMut(Vec<(CacheKey, Vec<u8>)>) -> Result<usize>,
  ) -> Result<usize> {
    let graph = &self.graph;
    let codec = CacheCodec::new(None);
    let mut ids = graph
      .get_module_graph()
      .modules()
      .map(|(id, _)| *id)
      .collect::<Vec<_>>();
    ids.sort_unstable_by(|a, b| a.as_str().cmp(b.as_str()));
    let mut index = Vec::new();
    let mut count = 0;
    // Commit at most 4 MiB of ordinary packs at a time. An individual
    // value may be larger, up to the explicit 8 MiB recovery limit.
    // The serialized byte cap is checked before adding each value to a batch.
    let mut pending = Vec::new();
    let mut bytes = 0;
    for ids in ids.chunks(CHUNK) {
      let start = timer_start();
      let nodes = ids.iter().map(|id| topology(graph, id)).collect::<Vec<_>>();
      let value = codec.encode(&nodes)?;
      if value.len() > MAX_RECORD_BYTES {
        return Err(error!("oversized topology"));
      }
      timer_add(2, start);
      count_add(5, value.len());
      count_add(7, ids.len());
      if !pending.is_empty() && bytes + value.len() > PACKET_BYTES {
        count += commit(std::mem::take(&mut pending))?;
        bytes = 0;
      }
      let key = key(ids[0].as_str());
      index.push(key.as_str().to_owned());
      bytes += value.len();
      pending.push((key, value));
    }
    if !pending.is_empty() {
      count += commit(pending)?;
    }
    // Index is published only after all packs are committed.
    count += commit(vec![
      (CacheKey::new(SNAPSHOT), codec.encode(&self.snapshot)?),
      (CacheKey::new(INDEX), index.join("\n").into_bytes()),
    ])?;
    Ok(count)
  }
}

fn recover_packed(
  graph: &mut BuildModuleGraphArtifact,
  strategy: &FileCacheStrategy,
  cache: &CacheFacade,
  codec: &CacheCodec,
  keys: &[&str],
) -> Result<()> {
  let produce = |mut consume: Box<
    dyn FnMut(Vec<(ModuleRef, Node<'static>)>) -> Result<()> + '_,
  >|
   -> Result<()> {
    let mut values = Vec::new();
    let mut total = 0;
    let decode = |values: Vec<Vec<u8>>| -> Result<Vec<(ModuleRef, Node<'static>)>> {
      values
        .into_par_iter()
        .map(|bytes| -> Result<_> {
          let start = timer_start();
          let nodes: Vec<Node<'static>> = codec.decode(&bytes)?;
          timer_add(3, start);
          if nodes.len() > CHUNK {
            return Err(error!("oversized topology node count"));
          }
          drop(bytes);
          nodes
            .into_par_iter()
            .map(|node| -> Result<_> {
              let id = node.mgm.as_ref().module_identifier;
              let value = cache
                .get::<ModuleRef>(id.as_str(), None)
                .ok_or_else(|| error!("missing module {id}"))?;
              let module = value.as_arc().as_ref().clone();
              module.reset_for_compilation(module.factory_meta());
              Ok((module, node))
            })
            .collect::<Result<Vec<_>>>()
        })
        .collect::<Result<Vec<_>>>()
        .map(|packs| packs.into_iter().flatten().collect())
    };
    for key in keys {
      let start = timer_start();
      let bytes = strategy
        .probe_graph_get(&CacheKey::new(key))
        .ok_or_else(|| error!("missing topology {key}"))?;
      timer_add(2, start);
      count_add(5, bytes.len());
      count_add(7, 1);
      if bytes.len() > MAX_RECORD_BYTES {
        return Err(error!("oversized topology"));
      }
      if !values.is_empty() && (total + bytes.len() > PACKET_BYTES || values.len() >= 4) {
        consume(decode(std::mem::take(&mut values))?)?;
        total = 0;
      }
      total += bytes.len();
      values.push(bytes);
    }
    if !values.is_empty() {
      consume(decode(values)?)?;
    }
    Ok(())
  };
  let (tx, rx) = std::sync::mpsc::sync_channel(1);
  std::thread::scope(|scope| {
    scope.spawn(move || {
      let result = produce(Box::new(|records| {
        tx.send(Ok(records))
          .map_err(|_| error!("graph consumer stopped"))
      }));
      if let Err(error) = result {
        let _ = tx.send(Err(error));
      }
    });
    let mut result = Ok(());
    while let Ok(records) = rx.recv() {
      match records {
        Ok(records) => {
          let start = timer_start();
          for (module, node) in records {
            if let Err(error) = install(graph, module, node) {
              result = Err(error);
              break;
            }
          }
          timer_add(8, start);
        }
        Err(error) => result = Err(error),
      }
      if result.is_err() {
        break;
      }
    }
    drop(rx);
    result
  })
}

pub(crate) async fn prepare(compilation: &mut Compilation) -> Result<()> {
  if std::env::var_os("RSPACK_PROBE_GRAPH").is_none() || compilation.is_rebuild {
    return Ok(());
  }
  let Some(strategy) = compilation.probe_graph_strategy() else {
    return Ok(());
  };
  // Existing topology is immutable. Changed input takes ordinary replay but does
  // not refresh the topology in this deliberately one-seed prototype.
  if strategy.probe_graph_get(&CacheKey::new(INDEX)).is_some() {
    return Ok(());
  }
  let graph = &compilation.build_module_graph_artifact;
  let files: InternedPathSet = graph.file_dependencies.files().cloned().collect();
  let contexts: InternedPathSet = graph.context_dependencies.files().cloned().collect();
  let missing: InternedPathSet = graph.missing_dependencies.files().cloned().collect();
  compilation.probe_graph_snapshot = Some(
    compilation
      .file_system_info
      .create_snapshot(
        None,
        &files,
        &contexts,
        &missing,
        compilation.options.snapshot.module,
      )
      .await?,
  );
  Ok(())
}

pub(crate) fn queue(compilation: &mut Compilation) {
  let Some(snapshot) = compilation.probe_graph_snapshot.take() else {
    return;
  };
  if let Some(strategy) = compilation.probe_graph_strategy() {
    strategy.probe_graph_store(PendingGraph {
      graph: compilation.build_module_graph_artifact.share(),
      snapshot,
    });
  }
}

pub(crate) async fn restore(compilation: &mut Compilation) -> bool {
  if std::env::var_os("RSPACK_PROBE_GRAPH").is_none() || compilation.is_rebuild {
    return false;
  }
  let Some(strategy) = compilation.probe_graph_strategy() else {
    return false;
  };
  match recover(compilation, &strategy).await {
    Ok(Some(graph)) => {
      *compilation.build_module_graph_artifact = graph;
      eprintln!("Benchmark bulk graph recovered");
      true
    }
    Ok(None) => false,
    Err(e) => {
      eprintln!("Benchmark bulk graph fallback: {e}");
      false
    }
  }
}

async fn recover(
  compilation: &mut Compilation,
  strategy: &FileCacheStrategy,
) -> Result<Option<BuildModuleGraphArtifact>> {
  if *TIMING {
    for metric in &METRICS {
      metric.store(0, Ordering::Relaxed);
    }
  }
  let index_start = Instant::now();
  let Some(index) = strategy.probe_graph_get(&CacheKey::new(INDEX)) else {
    return Ok(None);
  };
  let index_ms = millis(index_start);
  let snapshot_start = Instant::now();
  let codec = CacheCodec::new(None);
  let snapshot = strategy
    .probe_graph_get(&CacheKey::new(SNAPSHOT))
    .ok_or_else(|| error!("missing graph snapshot"))?;
  let snapshot: Snapshot = codec.decode(&snapshot)?;
  let snapshot_read_decode_ms = millis(snapshot_start);
  let snapshot_validation_start = Instant::now();
  let validation = {
    let mut modified_files = InternedPathSet::default();
    let mut removed_files = InternedPathSet::default();
    snapshot
      .probe_graph_validation_shards()
      .into_iter()
      .map(|snapshot| {
        let info = compilation.file_system_info.clone();
        async move { info.check_snapshot_valid(&snapshot).await }
      })
      .try_fut_consume(|result| {
        if let SnapshotValidationResult::Invalid {
          modified_files: modified,
          removed_files: removed,
        } = result
        {
          modified_files.extend(modified);
          removed_files.extend(removed);
        }
      })
      .await?;
    if modified_files.is_empty() && removed_files.is_empty() {
      SnapshotValidationResult::Valid
    } else {
      SnapshotValidationResult::Invalid {
        modified_files,
        removed_files,
      }
    }
  };
  if let SnapshotValidationResult::Invalid {
    modified_files,
    removed_files,
  } = validation
  {
    eprintln!(
      "Benchmark bulk graph fallback: {} modified, {} removed paths",
      modified_files.len(),
      removed_files.len()
    );
    return Ok(None);
  }
  let validation_ms = millis(snapshot_validation_start);
  let index = String::from_utf8(index).map_err(|e| error!("invalid graph index: {e}"))?;
  let ids = index.lines().collect::<Vec<_>>();
  let cache = compilation.get_cache("Compilation/modules");
  let mut graph = BuildModuleGraphArtifact::new();
  let mut chunks = Vec::new();
  let records_start = Instant::now();
  recover_packed(&mut graph, strategy, &cache, &codec, &ids)?;
  if *TIMING {
    chunks.push((
      ids.len(),
      millis(records_start),
      0.0,
      METRICS.each_ref().map(|v| v.swap(0, Ordering::Relaxed)),
    ));
  }
  let incoming_start = Instant::now();
  // Rebuild incoming connections only after every target graph module exists.
  let connections = graph
    .module_graph
    .module_graph_modules()
    .flat_map(|(_, m)| m.outgoing_connections().iter().copied())
    .collect::<Vec<_>>();
  for id in connections {
    let target = *graph
      .module_graph
      .connection_by_id(&id)
      .expect("connection must exist")
      .module_identifier();
    graph
      .module_graph
      .module_graph_module_by_identifier_mut(&target)
      .add_incoming_connection(id);
  }
  let incoming_ms = millis(incoming_start);
  let entry_start = Instant::now();
  // Like legacy recovery, synthetic links let make repair current entry identity.
  let entries = graph
    .module_graph
    .module_graph_modules()
    .filter(|(_, m)| m.issuer().identifier().is_none())
    .map(|(_, m)| m.module_identifier)
    .collect::<Vec<_>>();
  for id in entries {
    let dep = ProbeEntry::default();
    let con = ModuleGraphConnection::new(
      graph.module_graph.next_connection_id(),
      *dep.id(),
      None,
      id,
      false,
    );
    graph.entry_dependencies.insert(*dep.id());
    graph
      .module_graph
      .add_dependency(crate::BoxDependency::new(dep));
    graph.module_graph.cache_recovery_connection(con);
  }
  let entry_ms = millis(entry_start);
  let module_counters_start = Instant::now();
  for (id, module) in graph.module_graph.modules() {
    let info = module.build_info();
    let resource = ResourceId::from(*id);
    graph
      .file_dependencies
      .add_files(&resource, &info.dependencies.file);
    graph
      .context_dependencies
      .add_files(&resource, &info.dependencies.context);
    graph
      .missing_dependencies
      .add_files(&resource, &info.dependencies.missing);
    graph
      .build_dependencies
      .add_files(&resource, &info.dependencies.build);
    if !module.diagnostics().is_empty() {
      graph.make_failed_module.insert(*id);
    }
  }
  let module_counters_ms = millis(module_counters_start);
  let factor_counters_start = Instant::now();
  for (id, info) in graph.factorization_artifact.iter() {
    if !info.is_success() {
      graph.make_failed_dependencies.insert(id);
    }
    let resource = id.into();
    graph
      .file_dependencies
      .add_files(&resource, info.file_dependencies());
    graph
      .context_dependencies
      .add_files(&resource, info.context_dependencies());
    graph
      .missing_dependencies
      .add_files(&resource, info.missing_dependencies());
  }
  let factor_counters_ms = millis(factor_counters_start);
  let exports_start = Instant::now();
  for (id, _) in graph.get_module_graph().modules() {
    compilation.exports_info_artifact.new_exports_info(*id);
  }
  let exports_ms = millis(exports_start);
  if *TIMING {
    let mut metrics = METRICS.each_ref().map(|v| v.swap(0, Ordering::Relaxed));
    for chunk in &chunks {
      for (sum, value) in metrics.iter_mut().zip(chunk.3) {
        *sum += value;
      }
    }
    eprintln!(
      "GRAPH_TIMERS index_ms={index_ms} snapshot_read_decode_ms={snapshot_read_decode_ms} snapshot_ms={validation_ms} module_lookup_cpu_ms={} module_decode_cpu_ms={} topology_lookup_cpu_ms={} topology_decode_cpu_ms={} module_bytes={} topology_bytes={} module_lookups={} topology_lookups={} stream_install_ms={} incoming_ms={incoming_ms} entries_ms={entry_ms} module_counters_ms={module_counters_ms} factor_counters_ms={factor_counters_ms} exports_ms={exports_ms} chunks={chunks:?}",
      metrics[0] as f64 / 1e6,
      metrics[1] as f64 / 1e6,
      metrics[2] as f64 / 1e6,
      metrics[3] as f64 / 1e6,
      metrics[4],
      metrics[5],
      metrics[6],
      metrics[7],
      metrics[8] as f64 / 1e6
    );
  }
  Ok(Some(graph))
}

fn install(graph: &mut BuildModuleGraphArtifact, module: ModuleRef, node: Node<'_>) -> Result<()> {
  let id = module.identifier();
  let mut deps = module.get_dependencies().to_vec();
  let mut blocks = module.get_block_refs().to_vec();
  while let Some(block) = blocks.pop() {
    deps.extend(block.get_dependencies().iter().cloned());
    blocks.extend(block.get_block_refs().iter().cloned());
    graph.module_graph.add_block(block);
  }
  let dep_ids = deps
    .iter()
    .map(|dep| *dep.id())
    .collect::<rustc_hash::FxHashSet<_>>();
  for dep in deps {
    graph.module_graph.add_dependency_ref(dep);
  }
  for (index_in_block, (dep, block, info)) in node.dependencies.into_iter().enumerate() {
    // A topology reference without its module-owned object is a cache miss.
    if !dep_ids.contains(&dep) {
      return Err(error!("missing dependency in module {id}"));
    }
    graph.module_graph.set_parents(
      dep,
      DependencyParents {
        module: id,
        block,
        index_in_block,
      },
    );
    if let Some(info) = info {
      graph.factorization_artifact.insert(info.into_owned());
    }
  }
  for con in node.connections {
    graph
      .module_graph
      .cache_recovery_connection(con.into_owned());
  }
  if let Some(lazy) = node.lazy_info {
    graph
      .module_to_lazy_make
      .update_module_lazy_dependencies(id, Some(lazy.into_owned()));
  }
  graph
    .module_graph
    .add_module_graph_module(node.mgm.into_owned());
  graph.module_graph.add_module(module);
  Ok(())
}

#[cacheable]
#[derive(Debug, Default)]
struct ProbeEntry {
  id: DependencyId,
}
#[rspack_cacheable::cacheable_dyn]
impl Dependency for ProbeEntry {
  fn id(&self) -> &DependencyId {
    &self.id
  }
  fn could_affect_referencing_module(&self) -> crate::AffectType {
    unreachable!()
  }
}
impl crate::AsModuleDependency for ProbeEntry {}
impl crate::AsDependencyCodeGeneration for ProbeEntry {}
impl crate::AsContextDependency for ProbeEntry {}
