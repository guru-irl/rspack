#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::sync::Arc;
use std::{
  fmt,
  hash::Hasher,
  time::{SystemTime, UNIX_EPOCH},
};

use rayon::iter::{IntoParallelIterator, ParallelIterator};
use rspack_error::Result;
use rspack_paths::Utf8PathBuf;
use turbo_persistence::{
  CompactConfig, DbConfig, FamilyConfig, FamilyKind, KeyBase, ParallelScheduler, QueryKey,
  StoreKey, TurboPersistence,
};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::InfrastructureLogger;
use crate::new_cache::{
  CacheKey,
  db::{DatabaseFamily, DatabaseValue},
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
  prefetch: prefetch::Prefetch,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl Drop for TurboDatabase {
  fn drop(&mut self) {
    self.prefetch.cancel();
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
    #[cfg(any(target_os = "linux", target_os = "macos"))] logger: Arc<InfrastructureLogger>,
  ) -> Result<Self> {
    let warm = prefetch::is_warm(&path);
    let inner = open_database(&path, readonly)
      .map_err(|error| rspack_error::error!("Open cache database from {path} failed: {error}"))?;
    let prefetch = prefetch::Prefetch::start(
      warm,
      &path,
      #[cfg(any(target_os = "linux", target_os = "macos"))]
      logger,
    );
    Ok(Self {
      inner,
      base_path,
      path,
      readonly,
      prefetch,
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

  pub fn reset(&mut self) -> Result<()> {
    self.prefetch.cancel_and_join();
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
    self.prefetch.cancel();
    self.inner.clear_cache();
    self.inner.shutdown()?;
    Ok(())
  }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod prefetch {
  use std::{
    os::fd::AsRawFd,
    sync::{
      Arc,
      atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Instant,
  };

  use rspack_paths::Utf8PathBuf;

  use super::MB;
  use crate::{InfrastructureLogger, Logger};

  pub(super) struct Prefetch {
    thread: Option<(Arc<AtomicBool>, JoinHandle<()>)>,
  }

  pub(super) fn is_warm(path: &Utf8PathBuf) -> bool {
    // Any value, including empty or "0", disables prefetch.
    std::env::var_os("RSPACK_DISABLE_CACHE_PREFETCH").is_none() && path.join("CURRENT").is_file()
  }

  impl Prefetch {
    pub(super) fn start(warm: bool, path: &Utf8PathBuf, logger: Arc<InfrastructureLogger>) -> Self {
      let thread = if warm {
        let cancelled = Arc::new(AtomicBool::new(false));
        let thread_cancelled = cancelled.clone();
        let thread_path = path.clone();
        // Advisory readahead skips resident pages without a userspace read buffer.
        // Keep this I/O off the compilation pools with a small, fixed thread stack.
        std::thread::Builder::new()
          .name("rspack-cache-prefetch".into())
          .stack_size(64 * 1024)
          .spawn(move || prefetch_files(thread_path, thread_cancelled, logger))
          .ok()
          .map(|thread| (cancelled, thread))
      } else {
        None
      };
      Self { thread }
    }

    pub(super) fn cancel(&self) {
      if let Some((cancelled, _)) = &self.thread {
        cancelled.store(true, Ordering::Relaxed);
      }
    }

    pub(super) fn cancel_and_join(&mut self) {
      self.cancel();
      if let Some((_, thread)) = self.thread.take() {
        // Keep reset deterministic and stop advising files that are being discarded.
        // This runs on the idle-cache thread, waiting only for in-flight I/O.
        let _ = thread.join();
      }
    }
  }

  fn prefetch_files(
    path: Utf8PathBuf,
    cancelled: Arc<AtomicBool>,
    logger: Arc<InfrastructureLogger>,
  ) {
    const CHUNK_SIZE: u64 = 4 * MB;
    let start = Instant::now();
    let mut files = 0;
    let mut bytes = 0_u64;
    // Blobs already read sequentially on lookup; prefetch would also read dead blobs.
    // Stream metadata first, then SSTs, without retaining a list of cache files.
    for extension in ["meta", "sst"] {
      if cancelled.load(Ordering::Relaxed) {
        break;
      }
      if let Ok(entries) = std::fs::read_dir(&path) {
        for entry in entries.flatten() {
          if cancelled.load(Ordering::Relaxed) {
            break;
          }
          let file_path = entry.path();
          if file_path.extension().and_then(|ext| ext.to_str()) != Some(extension)
            || !entry.file_type().is_ok_and(|kind| kind.is_file())
          {
            continue;
          }
          // Compaction may remove a file between the directory scan and the advice.
          let Ok(file) = std::fs::File::open(file_path) else {
            continue;
          };
          let Ok(metadata) = file.metadata() else {
            continue;
          };
          files += 1;
          let mut offset = 0_u64;
          while offset < metadata.len() && !cancelled.load(Ordering::Relaxed) {
            let length = CHUNK_SIZE.min(metadata.len() - offset);
            let Ok(advice_offset) = libc::off_t::try_from(offset) else {
              break;
            };
            let result = advise_file(&file, advice_offset, length);
            if result != 0 {
              break;
            }
            offset += length;
            bytes += length;
          }
        }
      }
    }
    // Bytes count advisory ranges, not confirmed I/O or completed residency.
    logger.debug(format!(
      "Prefetched cache ({files} files, {bytes} bytes, {} ms)",
      start.elapsed().as_millis()
    ));
  }

  #[cfg(target_os = "linux")]
  fn advise_file(file: &std::fs::File, offset: libc::off_t, length: u64) -> libc::c_int {
    // Returns zero on success or an error number; nonzero stops advice for this file.
    // SAFETY: the file owns a live descriptor and the checked offset and bounded
    // length describe only the advisory range; no pointer is used.
    unsafe {
      libc::posix_fadvise(
        file.as_raw_fd(),
        offset,
        length as libc::off_t,
        libc::POSIX_FADV_WILLNEED,
      )
    }
  }

  #[cfg(target_os = "macos")]
  fn advise_file(file: &std::fs::File, offset: libc::off_t, length: u64) -> libc::c_int {
    // Returns zero on success or -1 with errno; nonzero stops advice for this file.
    let advice = libc::radvisory {
      ra_offset: offset,
      ra_count: length as libc::c_int,
    };
    // SAFETY: the file owns a live descriptor and advice points to an initialized
    // radvisory that remains valid for this non-retaining fcntl call.
    unsafe {
      libc::fcntl(
        file.as_raw_fd(),
        libc::F_RDADVISE,
        &advice as *const libc::radvisory,
      )
    }
  }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod prefetch {
  use rspack_paths::Utf8PathBuf;

  pub(super) struct Prefetch;

  pub(super) fn is_warm(_path: &Utf8PathBuf) -> bool {
    false
  }

  impl Prefetch {
    pub(super) fn start(_warm: bool, _path: &Utf8PathBuf) -> Self {
      Self
    }

    pub(super) fn cancel(&self) {}

    pub(super) fn cancel_and_join(&mut self) {}
  }
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
