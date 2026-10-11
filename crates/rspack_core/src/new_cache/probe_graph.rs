//! Throwaway no-change graph-recovery probe. Not safe for edits or plugin/config changes.
//! Deliberately reuses the legacy format across the backend boundary for measurement only.
use std::sync::Arc;

use rayon::prelude::*;
use rspack_storage::Storage;

use super::{CacheKey, FileCacheStrategy};
use crate::{
  Compilation,
  cache::CacheCodec,
  legacy_cache::persistent::occasion::{MakeOccasion, Occasion},
};

const INDEX: &str = "probe_graph_index";

#[derive(Debug)]
struct GraphStorage {
  strategy: Arc<FileCacheStrategy>,
  writes: Vec<(Vec<u8>, Vec<u8>)>,
}
fn key(id: &[u8]) -> CacheKey {
  CacheKey::from(format!(
    "probe_graph_node|{}",
    std::str::from_utf8(id).unwrap()
  ))
}
#[async_trait::async_trait]
impl Storage for GraphStorage {
  async fn load(&self, _: &'static str) -> rspack_storage::Result<Vec<(Vec<u8>, Vec<u8>)>> {
    let bytes = self
      .strategy
      .probe_graph_get(&CacheKey::new(INDEX))
      .unwrap();
    let ids = String::from_utf8(bytes).unwrap();
    Ok(
      ids
        .lines()
        .collect::<Vec<_>>()
        .into_par_iter()
        .map(|id| {
          (
            id.as_bytes().to_vec(),
            self.strategy.probe_graph_get(&key(id.as_bytes())).unwrap(),
          )
        })
        .collect(),
    )
  }
  fn set(&mut self, _: &'static str, id: Vec<u8>, value: Vec<u8>) {
    self.writes.push((id, value));
  }
  fn remove(&mut self, _: &'static str, _: &[u8]) {
    panic!("no edits supported")
  }
  fn save(&mut self) {}
  async fn flush(&self) {}
  fn reset(&mut self, _: &'static str) {
    panic!("no invalidation supported")
  }
  fn reset_all(&mut self) {
    panic!("no invalidation supported")
  }
  async fn scopes(&self) -> rspack_storage::Result<Vec<String>> {
    Ok(vec![])
  }
}

pub(crate) async fn restore(compilation: &mut Compilation) -> bool {
  if std::env::var_os("RSPACK_PROBE_GRAPH").is_none() || compilation.is_rebuild {
    return false;
  }
  let Some(strategy) = compilation.probe_graph_strategy() else {
    return false;
  };
  if strategy.probe_graph_get(&CacheKey::new(INDEX)).is_none() {
    return false;
  }
  let storage = GraphStorage {
    strategy,
    writes: vec![],
  };
  let occasion = MakeOccasion::new(Arc::new(CacheCodec::new(None)));
  let graph = occasion.recovery(&storage).await.unwrap();
  *compilation.build_module_graph_artifact = graph;
  for (module, _) in compilation
    .build_module_graph_artifact
    .get_module_graph()
    .modules()
  {
    compilation.exports_info_artifact.new_exports_info(*module);
  }
  eprintln!("Benchmark bulk graph recovered");
  true
}

pub(crate) fn store(compilation: &Compilation) {
  if std::env::var_os("RSPACK_PROBE_GRAPH").is_none() || compilation.is_rebuild {
    return;
  }
  let Some(strategy) = compilation.probe_graph_strategy() else {
    return;
  };
  // The closed cold seed is immutable for this no-change upper bound.
  if strategy.probe_graph_get(&CacheKey::new(INDEX)).is_some() {
    return;
  }
  let mut storage = GraphStorage {
    strategy,
    writes: vec![],
  };
  MakeOccasion::new(Arc::new(CacheCodec::new(None)))
    .save(&mut storage, &compilation.build_module_graph_artifact);
  let index = storage
    .writes
    .iter()
    .map(|(id, _)| std::str::from_utf8(id).unwrap())
    .collect::<Vec<_>>()
    .join("\n")
    .into_bytes();
  let mut entries = storage
    .writes
    .into_iter()
    .map(|(id, value)| (key(&id), value))
    .collect::<Vec<_>>();
  entries.push((CacheKey::new(INDEX), index));
  storage.strategy.probe_graph_store(entries);
}
