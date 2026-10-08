use std::{
  fmt,
  hash::Hasher,
  io::Read,
  sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
  },
  time::{Instant, SystemTime, UNIX_EPOCH},
};

use rayon::iter::{IntoParallelIterator, ParallelIterator};
use rspack_error::Result;
use rspack_paths::Utf8PathBuf;
use turbo_persistence::{
  CompactConfig, DbConfig, FamilyConfig, FamilyKind, KeyBase, ParallelScheduler, QueryKey,
  StoreKey, TurboPersistence,
};

use crate::{
  InfrastructureLogger, Logger,
  new_cache::{
    CacheKey,
    db::{DatabaseFamily, DatabaseValue},
  },
};

const STALE_DIRECTORY: &str = "_stale";
const MB: u64 = 1024 * 1024;

// Keep idle compaction selective and bounded. This follows Turbopack's
// compaction thresholds, while limiting each call to one merge segment to keep
// idle work responsive to interruption.
const COMPACT_CONFIG: CompactConfig = CompactConfig {
  min_merge_count: 3,
  optimal_merge_count: 8,
  max_merge_count: 64,
  max_merge_bytes: 512 * MB,
  min_merge_duplication_bytes: 50 * MB,
  optimal_merge_duplication_bytes: 100 * MB,
  max_merge_segment_count: 1,
};

#[derive(Clone, Copy, Default)]
struct RayonParallelScheduler;

impl ParallelScheduler for RayonParallelScheduler {
  fn block_in_place<R>(&self, f: impl FnOnce() -> R + Send) -> R
  where
    R: Send,
  {
    f()
  }

  fn parallel_for_each<T>(&self, items: &[T], f: impl Fn(&T) + Send + Sync)
  where
    T: Sync,
  {
    if items.len() <= 1 {
      items.iter().for_each(f);
      return;
    }

    items.into_par_iter().for_each(f);
  }

  fn try_parallel_for_each<'l, T, E>(
    &self,
    items: &'l [T],
    f: impl (Fn(&'l T) -> Result<(), E>) + Send + Sync,
  ) -> Result<(), E>
  where
    T: Sync,
    E: Send + 'static,
  {
    if items.len() <= 1 {
      for item in items {
        f(item)?;
      }
      return Ok(());
    }

    items.into_par_iter().try_for_each(f)
  }

  fn try_parallel_for_each_mut<'l, T, E>(
    &self,
    items: &'l mut [T],
    f: impl (Fn(&'l mut T) -> Result<(), E>) + Send + Sync,
  ) -> Result<(), E>
  where
    T: Send + Sync,
    E: Send + 'static,
  {
    if items.len() <= 1 {
      for item in items {
        f(item)?;
      }
      return Ok(());
    }

    items.into_par_iter().try_for_each(f)
  }

  fn try_parallel_for_each_owned<T, E>(
    &self,
    items: Vec<T>,
    f: impl (Fn(T) -> Result<(), E>) + Send + Sync,
  ) -> Result<(), E>
  where
    T: Send + Sync,
    E: Send + 'static,
  {
    if items.len() <= 1 {
      for item in items {
        f(item)?;
      }
      return Ok(());
    }

    items.into_par_iter().try_for_each(f)
  }

  fn parallel_map_collect<'l, Item, PerItemResult, Output>(
    &self,
    items: &'l [Item],
    f: impl Fn(&'l Item) -> PerItemResult + Send + Sync,
  ) -> Output
  where
    Item: Sync,
    PerItemResult: Send + Sync + 'l,
    Output: FromIterator<PerItemResult>,
  {
    if items.len() <= 1 {
      return items.iter().map(f).collect();
    }

    items
      .into_par_iter()
      .map(f)
      .collect_vec_list()
      .into_iter()
      .flatten()
      .collect()
  }

  fn parallel_map_collect_owned<Item, PerItemResult, Output>(
    &self,
    items: Vec<Item>,
    f: impl Fn(Item) -> PerItemResult + Send + Sync,
  ) -> Output
  where
    Item: Send + Sync,
    PerItemResult: Send + Sync,
    Output: FromIterator<PerItemResult>,
  {
    if items.len() <= 1 {
      return items.into_iter().map(f).collect();
    }

    items
      .into_par_iter()
      .map(f)
      .collect_vec_list()
      .into_iter()
      .flatten()
      .collect()
  }
}

type Inner = TurboPersistence<RayonParallelScheduler, { DatabaseFamily::COUNT }>;

impl KeyBase for CacheKey {
  fn len(&self) -> usize {
    self.as_bytes().len()
  }

  fn hash<H: Hasher>(&self, state: &mut H) {
    state.write(self.as_bytes());
  }
}

impl QueryKey for CacheKey {
  fn cmp(&self, key: &[u8]) -> std::cmp::Ordering {
    self.as_bytes().cmp(key)
  }
}

impl StoreKey for CacheKey {
  fn write_to(&self, buffer: &mut Vec<u8>) {
    buffer.extend_from_slice(self.as_bytes());
  }
}

pub struct TurboDatabase {
  inner: Inner,
  base_path: Utf8PathBuf,
  path: Utf8PathBuf,
  readonly: bool,
  prefetch_cancelled: Option<Arc<AtomicBool>>,
}

impl Drop for TurboDatabase {
  fn drop(&mut self) {
    self.cancel_prefetch();
  }
}

impl fmt::Debug for TurboDatabase {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter
      .debug_struct("TurboDatabase")
      .field("base_path", &self.base_path)
      .field("path", &self.path)
      .field("readonly", &self.readonly)
      .finish_non_exhaustive()
  }
}

impl TurboDatabase {
  pub fn open(
    base_path: Utf8PathBuf,
    path: Utf8PathBuf,
    readonly: bool,
    logger: Arc<InfrastructureLogger>,
  ) -> Result<Self> {
    let warm = path.join("CURRENT").is_file();
    let inner = open_database(&path, readonly)
      .map_err(|error| rspack_error::error!("Open cache database from {path} failed: {error}"))?;
    let prefetch_cancelled = if warm && std::env::var_os("RSPACK_DISABLE_CACHE_PREFETCH").is_none()
    {
      let cancelled = Arc::new(AtomicBool::new(false));
      let thread_cancelled = cancelled.clone();
      let thread_path = path.clone();
      // A dedicated I/O thread keeps sequential reads off the compilation pools.
      // The buffer lives on its bounded stack and is released when prefetch ends.
      let _ = std::thread::Builder::new()
        .name("rspack-cache-prefetch".into())
        .stack_size(512 * 1024)
        .spawn(move || prefetch_files(thread_path, thread_cancelled, logger));
      Some(cancelled)
    } else {
      None
    };
    Ok(Self {
      inner,
      base_path,
      path,
      readonly,
      prefetch_cancelled,
    })
  }

  pub fn get(&self, family: DatabaseFamily, key: &CacheKey) -> Result<Option<DatabaseValue>> {
    Ok(self.inner.get(family.index(), &key)?)
  }

  pub fn is_empty(&self) -> bool {
    self.inner.is_empty()
  }

  pub fn write_batch(
    &self,
    writes: impl ParallelIterator<Item = (DatabaseFamily, CacheKey, Vec<u8>)>,
  ) -> Result<usize> {
    let batch = self.inner.write_batch::<CacheKey>()?;
    let writes_len = writes
      .try_fold(
        || 0,
        |count, (family, key, value)| -> Result<usize> {
          batch.put(family.index() as u32, key, value.into())?;
          Ok(count + 1)
        },
      )
      .try_reduce(|| 0, |a, b| Ok(a + b))?;
    if writes_len > 0 {
      self.inner.commit_write_batch(batch)?;
    }
    Ok(writes_len)
  }

  pub fn compact(&self) -> Result<()> {
    if self.readonly || self.inner.is_empty() {
      return Ok(());
    }
    self.inner.compact(&COMPACT_CONFIG)?;
    Ok(())
  }

  pub fn has_unrecoverable_write_error(&self) -> bool {
    self.inner.has_unrecoverable_write_error()
  }

  fn cancel_prefetch(&self) {
    if let Some(cancelled) = &self.prefetch_cancelled {
      cancelled.store(true, Ordering::Relaxed);
    }
  }

  pub fn reset(&mut self) -> Result<()> {
    self.cancel_prefetch();
    let old_database = std::mem::replace(
      &mut self.inner,
      Inner::empty_in_memory_with_config(database_config()),
    );
    old_database.clear_cache();
    old_database.shutdown()?;
    drop(old_database);

    if !self.readonly {
      move_to_stale(&self.base_path, &self.path)?;
      self.inner = open_database(&self.path, false)?;
    }
    Ok(())
  }

  pub fn cleanup_stale(&self) -> Result<()> {
    let stale_directory = stale_directory(&self.base_path);
    match std::fs::remove_dir_all(stale_directory) {
      Ok(()) => Ok(()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(error) => Err(error.into()),
    }
  }

  pub fn shutdown(self) -> Result<()> {
    self.cancel_prefetch();
    self.inner.clear_cache();
    self.inner.shutdown()?;
    Ok(())
  }
}

#[allow(
  clippy::large_stack_arrays,
  reason = "The prefetch thread reserves an explicitly sized stack for this fixed buffer"
)]
fn prefetch_files(
  path: Utf8PathBuf,
  cancelled: Arc<AtomicBool>,
  logger: Arc<InfrastructureLogger>,
) {
  let start = Instant::now();
  let mut buffer = [0_u8; 256 * 1024];
  let mut files = 0;
  let mut bytes = 0_u64;
  // Blobs already read sequentially on lookup; prefetch would also read dead blobs.
  // Stream directory entries rather than retaining a list of cache files.
  if let Ok(entries) = std::fs::read_dir(&path) {
    for entry in entries.flatten() {
      if cancelled.load(Ordering::Relaxed) {
        break;
      }
      let file_path = entry.path();
      let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str());
      if !matches!(extension, Some("sst" | "meta"))
        || !entry.file_type().is_ok_and(|kind| kind.is_file())
      {
        continue;
      }
      // Compaction may remove a file between the directory scan and the read.
      let Ok(mut file) = std::fs::File::open(file_path) else {
        continue;
      };
      files += 1;
      while !cancelled.load(Ordering::Relaxed) {
        match file.read(&mut buffer) {
          Ok(0) => break,
          Ok(read) => bytes += read as u64,
          Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
          Err(_) => break,
        }
      }
    }
  }
  logger.debug(format!(
    "Prefetched cache ({files} files, {bytes} bytes, {} ms)",
    start.elapsed().as_millis()
  ));
}

fn move_to_stale(base_path: &Utf8PathBuf, path: &Utf8PathBuf) -> Result<()> {
  if !path.is_dir() {
    return Ok(());
  }

  let file_name = path
    .file_name()
    .ok_or_else(|| rspack_error::error!("Persistent cache path has no directory name: {path}"))?;
  let stale_directory = stale_directory(base_path);
  std::fs::create_dir_all(&stale_directory).map_err(|error| {
    rspack_error::error!(
      "Failed to create stale cache directory {}: {error}",
      stale_directory
    )
  })?;
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_nanos();
  let stale_path = stale_directory.join(format!("{file_name}-{}-{timestamp}", std::process::id()));
  std::fs::rename(path, &stale_path).map_err(|error| {
    rspack_error::error!(
      "Failed to move invalid persistent cache database {path} to {stale_path}: {error}"
    )
  })?;
  Ok(())
}

fn stale_directory(base_path: &Utf8PathBuf) -> Utf8PathBuf {
  base_path.join(STALE_DIRECTORY)
}

fn open_database(path: &Utf8PathBuf, readonly: bool) -> Result<Inner> {
  let config = database_config();
  let db = if readonly {
    Inner::open_read_only_with_config(path.as_std_path().to_path_buf(), config)
  } else {
    Inner::open_with_config(path.as_std_path().to_path_buf(), config)
  }?;
  Ok(db)
}

fn database_config() -> DbConfig<{ DatabaseFamily::COUNT }> {
  DbConfig {
    family_configs: [
      FamilyConfig {
        name: "cache",
        kind: FamilyKind::SingleValue,
      },
      FamilyConfig {
        name: "validator",
        kind: FamilyKind::SingleValue,
      },
    ],
  }
}
