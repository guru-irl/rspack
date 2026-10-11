//! Fork-only bulk graph recovery measurement. Plugin and configuration eligibility is unchecked.
use std::{
  ops::{Deref, DerefMut},
  sync::Arc,
};

use rayon::prelude::*;
use rspack_cacheable::{cacheable, utils::OwnedOrRef};
use rspack_collections::Identifiable;
use rspack_error::{Result, error};
use rspack_paths::InternedPathSet;

use super::{CacheKey, FileCacheStrategy, Snapshot, SnapshotValidationResult};
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

impl PendingGraph {
  pub(crate) fn writes(&self) -> impl ParallelIterator<Item = (CacheKey, Vec<u8>)> + '_ {
    let graph = &self.graph;
    let mg = graph.get_module_graph();
    let mut ids = mg.modules().map(|(id, _)| *id).collect::<Vec<_>>();
    ids.sort_unstable_by(|a, b| a.as_str().cmp(b.as_str()));
    let index = ids
      .iter()
      .map(|id| id.as_str())
      .collect::<Vec<_>>()
      .join("\n")
      .into_bytes();
    // Only the small index and snapshot exist before the lazy record iterator.
    let codec = CacheCodec::new(None);
    let snapshot = codec
      .encode(&self.snapshot)
      .expect("probe snapshot must encode");
    ids
      .into_par_iter()
      .map(move |id| {
        let mgm = mg
          .module_graph_module_by_identifier(&id)
          .expect("graph module must exist");
        let node = Node {
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
            .get_lazy_dependencies(&id)
            .map(Into::into),
        };
        (
          key(id.as_str()),
          codec.encode(&node).expect("probe topology must encode"),
        )
      })
      .chain(
        vec![
          (CacheKey::new(INDEX), index),
          (CacheKey::new(SNAPSHOT), snapshot),
        ]
        .into_par_iter(),
      )
  }
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
      for (id, _) in compilation
        .build_module_graph_artifact
        .get_module_graph()
        .modules()
      {
        compilation.exports_info_artifact.new_exports_info(*id);
      }
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
  let Some(index) = strategy.probe_graph_get(&CacheKey::new(INDEX)) else {
    return Ok(None);
  };
  let codec = CacheCodec::new(None);
  let snapshot = strategy
    .probe_graph_get(&CacheKey::new(SNAPSHOT))
    .ok_or_else(|| error!("missing graph snapshot"))?;
  let snapshot: Snapshot = codec.decode(&snapshot)?;
  if let SnapshotValidationResult::Invalid {
    modified_files,
    removed_files,
  } = compilation
    .file_system_info
    .check_snapshot_valid(&snapshot)
    .await?
  {
    eprintln!(
      "Benchmark bulk graph fallback: {} modified, {} removed paths",
      modified_files.len(),
      removed_files.len()
    );
    return Ok(None);
  }
  drop(snapshot);
  let index = String::from_utf8(index).map_err(|e| error!("invalid graph index: {e}"))?;
  let ids = index.lines().collect::<Vec<_>>();
  let cache = compilation.get_cache("Compilation/modules");
  let mut graph = BuildModuleGraphArtifact::new();
  for chunk in ids.chunks(CHUNK) {
    // At most CHUNK serialized/decode results live between read and install.
    let records = chunk
      .par_iter()
      .map(|id| -> Result<_> {
        let module = cache
          .get::<ModuleRef>(id, None)
          .ok_or_else(|| error!("missing module {id}"))?;
        let bytes = strategy
          .probe_graph_get(&key(id))
          .ok_or_else(|| error!("missing graph node {id}"))?;
        let node: Node = codec.decode(&bytes)?;
        drop(bytes);
        let module = module.as_arc().as_ref().clone();
        module.reset_for_compilation(module.factory_meta());
        Ok((module, node))
      })
      .collect::<Result<Vec<_>>>()?;
    for (module, node) in records {
      install(&mut graph, module, node)?;
    }
  }
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
