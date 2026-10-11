use std::{
  future::Future,
  hash::{Hash, Hasher},
  path::Path,
  sync::Arc,
};

use rspack_cacheable::cacheable;
use rspack_util::{fx_hash::FxDashMap, time::current_time};
use rustc_hash::FxHasher;
use tokio::sync::Mutex;

use super::{CacheFacade, CacheValue, FileSystemInfo, Snapshot, SnapshotValidationResult};
use crate::{
  CacheCount, Logger, ResolveDependencies, ResolveInnerError, ResolveResult,
  SnapshotStrategyOptions,
};

#[cacheable]
struct CachedResolution {
  result: ResolveResult,
  dependencies: ResolveDependencies,
  snapshot: Snapshot,
}

/// Cloning shares cache, filesystem-info, request locks and statistics within one compilation.
#[derive(Debug, Clone)]
pub struct ResolverCache {
  cache: CacheFacade,
  file_system_info: FileSystemInfo,
  strategy: SnapshotStrategyOptions,
  counter: Arc<CacheCount>,
  locks: Arc<FxDashMap<u64, Arc<Mutex<()>>>>,
}

impl ResolverCache {
  pub(crate) fn new(
    cache: CacheFacade,
    file_system_info: FileSystemInfo,
    strategy: SnapshotStrategyOptions,
    logger: &impl Logger,
  ) -> Self {
    Self {
      cache,
      file_system_info,
      strategy,
      counter: Arc::new(logger.cache("resolver cache")),
      locks: Default::default(),
    }
  }

  pub(crate) fn child(&self, name: &str) -> Self {
    Self {
      cache: self.cache.get_child_cache(name),
      file_system_info: self.file_system_info.clone(),
      strategy: self.strategy,
      counter: Arc::clone(&self.counter),
      locks: Default::default(),
    }
  }

  pub(crate) async fn use_cache<G, F>(
    &self,
    options_key: u64,
    path: &Path,
    request: &str,
    generator: G,
  ) -> (
    Result<ResolveResult, ResolveInnerError>,
    ResolveDependencies,
  )
  where
    G: FnOnce() -> F,
    F: Future<
      Output = (
        Result<ResolveResult, ResolveInnerError>,
        ResolveDependencies,
      ),
    >,
  {
    let mut hasher = FxHasher::default();
    (options_key, path, request).hash(&mut hasher);
    let key = hasher.finish();
    // Keep the lock until the result is stored, so waiting requests can hit the cache.
    // Retain locks for this compilation so queued and new requests share the same lock.
    let lock = Arc::clone(self.locks.entry(key).or_default().value());
    let _guard = lock.lock().await;
    let item = self.cache.get_item_cache(&format!("{key:016x}"), None);
    if let Some(cached) = item.get::<CachedResolution>()
      && matches!(
        self
          .file_system_info
          .check_snapshot_valid(&cached.snapshot)
          .await,
        Ok(SnapshotValidationResult::Valid)
      )
    {
      self.counter.hit();
      return (Ok(cached.result.clone()), cached.dependencies.clone());
    }
    self.counter.miss();

    let start_time = current_time();
    let (result, dependencies) = generator().await;
    if let Ok(result) = &result
      && let Ok(snapshot) = self
        .file_system_info
        .create_snapshot(
          Some(start_time),
          &dependencies.file_dependencies,
          &Default::default(),
          &dependencies.missing_dependencies,
          self.strategy,
        )
        .await
    {
      item.store(CacheValue::new(CachedResolution {
        result: result.clone(),
        dependencies: dependencies.clone(),
        snapshot,
      }));
    }
    (result, dependencies)
  }

  pub(crate) fn release_persisted(&self) {
    self.cache.release_persisted();
  }

  pub(crate) fn release_unused_locks(&self) {
    // entry() and retain() synchronize on the same shard. Every active or queued
    // request owns an Arc, so no request can observe a second mutex for its key.
    self.locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    self.locks.shrink_to_fit();
  }

  pub(crate) fn log(&self, logger: &impl Logger) {
    logger.cache_end(self.counter.as_ref());
  }
}

/// Joins CPU-only eviction before done, including error unwinding. It transfers
/// existing owners to rayon and allocates no copy of the decoded values.
#[derive(Debug)]
pub(crate) struct ResolverCacheRelease {
  completed: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

impl ResolverCacheRelease {
  pub(crate) fn start(
    cache: ResolverCache,
    normal: Arc<crate::ResolverFactory>,
    loader: Arc<crate::ResolverFactory>,
  ) -> Self {
    let (sender, completed) = std::sync::mpsc::channel();
    rayon::spawn(move || {
      let start = std::time::Instant::now();
      cache.release_persisted();
      normal.release_unused_cache_locks();
      loader.release_unused_cache_locks();
      eprintln!(
        "Benchmark background resolver release {:.3} ms",
        start.elapsed().as_secs_f64() * 1000.0
      );
      let _ = sender.send(());
    });
    Self {
      completed: std::sync::Mutex::new(completed),
    }
  }
}

impl Drop for ResolverCacheRelease {
  fn drop(&mut self) {
    let start = std::time::Instant::now();
    let _ = self
      .completed
      .get_mut()
      .expect("release completion should not be poisoned")
      .recv();
    eprintln!(
      "Benchmark resolver release join {:.3} ms",
      start.elapsed().as_secs_f64() * 1000.0
    );
  }
}
