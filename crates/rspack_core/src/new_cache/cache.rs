use std::{ops::Deref, sync::Arc, time::Duration};

use rspack_paths::InternedPathSet;

use super::{
  CacheFacade, CacheKey, CacheValue, Etag, IdleFileCache, MemoryCache, MemoryCacheGetResult,
  cache_value::CacheValueData,
};

/// Storage shared by all compiler-scoped cache views.
#[derive(Debug)]
struct CacheStorage {
  memory_cache: Option<MemoryCache>,
  idle_file_cache: Option<IdleFileCache>,
}

/// Shared cache storage, independent of a compiler's namespace.
///
/// Reads follow webpack's cache stage order: memory is queried first and only
/// an unknown key falls through to the filesystem cache. Filesystem results,
/// including misses, are recorded in memory for subsequent reads.
#[derive(Debug)]
pub struct Cache {
  storage: Option<CacheStorage>,
  probe_counters: Option<
    std::sync::Mutex<std::collections::BTreeMap<Arc<str>, Arc<crate::owner_probe::Counters>>>,
  >,
}

impl Cache {
  /// Creates storage from the configured memory and filesystem caches.
  pub fn new(memory_cache: Option<MemoryCache>, idle_file_cache: Option<IdleFileCache>) -> Self {
    let storage = if memory_cache.is_some() || idle_file_cache.is_some() {
      Some(CacheStorage {
        memory_cache,
        idle_file_cache,
      })
    } else {
      None
    };
    Self {
      storage,
      probe_counters: crate::owner_probe::enabled().then(Default::default),
    }
  }

  pub fn new_disabled() -> Self {
    Self::new(None, None)
  }

  pub fn get<T: CacheValueData>(&self, key: CacheKey, etag: Option<Etag>) -> Option<CacheValue<T>> {
    self.owner_probe_get(key, etag, None)
  }

  pub(super) fn owner_probe_get<T: CacheValueData>(
    &self,
    key: CacheKey,
    etag: Option<Etag>,
    probe: Option<&crate::owner_probe::Counters>,
  ) -> Option<CacheValue<T>> {
    let Some(storage) = &self.storage else {
      if let Some(p) = &probe {
        p.record(&key, 3);
      }
      return None;
    };
    if let Some(memory_cache) = &storage.memory_cache {
      match memory_cache.get(&key, etag.as_ref()) {
        MemoryCacheGetResult::Hit(value) => {
          if let Some(p) = &probe {
            p.record(&key, 0);
          }
          return Some(value);
        }
        MemoryCacheGetResult::Miss => {
          if let Some(p) = &probe {
            p.record(&key, 3);
          }
          return None;
        }
        MemoryCacheGetResult::NotCached => {}
      }
    }

    let Some(file_cache) = &storage.idle_file_cache else {
      if let Some(p) = &probe {
        p.record(&key, 3);
      }
      if let Some(memory_cache) = &storage.memory_cache {
        memory_cache.store_miss(key);
      }
      return None;
    };

    match file_cache.restore::<T>(key.clone(), etag.clone(), probe) {
      Some(value) => {
        if let Some(memory_cache) = &storage.memory_cache {
          memory_cache.store(key, etag, value.clone());
        }
        Some(value)
      }
      None => {
        if let Some(memory_cache) = &storage.memory_cache {
          memory_cache.store_miss(key);
        }
        None
      }
    }
  }

  pub fn store<T: CacheValueData>(&self, key: CacheKey, etag: Option<Etag>, value: CacheValue<T>) {
    self.owner_probe_store(key, etag, value, None);
  }

  pub(super) fn owner_probe_store<T: CacheValueData>(
    &self,
    key: CacheKey,
    etag: Option<Etag>,
    value: CacheValue<T>,
    probe: Option<&crate::owner_probe::Counters>,
  ) {
    if let Some(p) = probe {
      p.record(&key, 4);
    }
    let Some(storage) = &self.storage else {
      return;
    };
    if let Some(memory_cache) = &storage.memory_cache {
      memory_cache.store(key.clone(), etag.clone(), value.clone());
    }
    if let Some(file_cache) = &storage.idle_file_cache {
      file_cache.store(key, etag, value)
    }
  }

  pub fn store_build_dependencies(&self, dependencies: InternedPathSet) {
    let Some(storage) = &self.storage else {
      return;
    };
    if let Some(file_cache) = &storage.idle_file_cache {
      file_cache.store_build_dependencies(dependencies);
    }
  }

  pub fn has_file_cache(&self) -> bool {
    self
      .storage
      .as_ref()
      .is_some_and(|storage| storage.idle_file_cache.is_some())
  }

  pub fn begin_idle(&self, build_time: Duration) {
    let Some(storage) = &self.storage else {
      return;
    };
    if let Some(memory_cache) = &storage.memory_cache {
      memory_cache.start_next_generation();
    }
    if let Some(file_cache) = &storage.idle_file_cache {
      file_cache.begin_idle(build_time);
    }
  }

  pub fn end_idle(&self) {
    let Some(storage) = &self.storage else {
      return;
    };
    if let Some(file_cache) = &storage.idle_file_cache {
      file_cache.end_idle();
    }
  }

  pub async fn shutdown(&self) {
    let Some(storage) = &self.storage else {
      return;
    };
    if let Some(file_cache) = &storage.idle_file_cache {
      file_cache.shutdown().await;
    }
    if let Some(memory_cache) = &storage.memory_cache {
      memory_cache.clear();
    }
  }
}

/// A compiler's view of shared cache storage.
#[derive(Debug, Clone)]
pub struct CompilerCache {
  cache: Arc<Cache>,
  compiler_path: Arc<str>,
}

impl Deref for CompilerCache {
  type Target = Cache;

  fn deref(&self) -> &Self::Target {
    &self.cache
  }
}

impl CompilerCache {
  pub fn new(cache: Arc<Cache>, compiler_path: Arc<str>) -> Self {
    Self {
      cache,
      compiler_path,
    }
  }

  pub fn facade(&self, name: &str) -> CacheFacade {
    let cache_name = [self.compiler_path.as_ref(), name].join("|");
    CacheFacade::new(Arc::clone(&self.cache), cache_name)
  }
}

impl Cache {
  pub(super) fn owner_probe_counter(
    &self,
    key: &CacheKey,
  ) -> Option<Arc<crate::owner_probe::Counters>> {
    let map = self.probe_counters.as_ref()?;
    let map = map.lock().expect("probe counters");
    map
      .iter()
      .filter(|(prefix, _)| {
        key
          .as_str()
          .strip_prefix(prefix.as_ref())
          .is_some_and(|s| s.starts_with('|'))
      })
      .max_by_key(|(prefix, _)| prefix.len())
      .map(|(_, c)| c.clone())
  }
  pub(crate) fn owner_probe_register(&self, prefix: Arc<str>) -> Arc<crate::owner_probe::Counters> {
    let counters = Arc::new(crate::owner_probe::Counters::default());
    if let Some(map) = &self.probe_counters {
      map
        .lock()
        .expect("probe counters")
        .insert(prefix, counters.clone());
    }
    counters
  }
  pub(crate) fn owner_probe_snapshot(&self, full: bool, prefix: &str) -> serde_json::Value {
    let Some(storage) = &self.storage else {
      return serde_json::Value::Null;
    };
    serde_json::json!({"tier_entries": storage.memory_cache.as_ref().map_or(0, MemoryCache::owner_probe_len),
      "tier_users": full.then(|| storage.memory_cache.as_ref().map_or([0;8], |m| m.owner_probe_users(prefix))),
      "file": storage.idle_file_cache.as_ref().map(|f| f.strategy.owner_probe_snapshot())})
  }
  pub(crate) fn owner_probe_drop_user(&self, prefix: &str, user: usize) {
    if let Some(m) = self.storage.as_ref().and_then(|s| s.memory_cache.as_ref()) {
      m.owner_probe_drop(prefix, user);
    }
  }
  pub(crate) fn owner_probe_drop_blocks(&self) {
    if let Some(f) = self
      .storage
      .as_ref()
      .and_then(|s| s.idle_file_cache.as_ref())
    {
      f.strategy.owner_probe_drop_blocks();
    }
  }
  pub(crate) fn owner_probe_drop_fsi(&self) {
    if let Some(f) = self
      .storage
      .as_ref()
      .and_then(|s| s.idle_file_cache.as_ref())
    {
      f.strategy.owner_probe_drop_fsi();
    }
  }
}
