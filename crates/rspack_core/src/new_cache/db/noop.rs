use rayon::iter::ParallelIterator;
use rspack_error::Result;

use crate::{
  InfrastructureLogger,
  new_cache::{
    CacheKey,
    db::{DatabaseFamily, DatabaseValue},
  },
};

pub struct PreparedDatabase;
pub struct NoopDatabase;

impl NoopDatabase {
  pub fn open(
    _base_path: rspack_paths::Utf8PathBuf,
    _path: rspack_paths::Utf8PathBuf,
    _readonly: bool,
  ) -> Result<Self> {
    Ok(Self)
  }

  pub fn get(&self, _family: DatabaseFamily, _key: &CacheKey) -> Result<Option<DatabaseValue>> {
    Ok(None)
  }

  pub fn is_empty(&self) -> bool {
    true
  }

  pub fn prepare_open(&self, _logger: &InfrastructureLogger) -> Result<Option<PreparedDatabase>> {
    Ok(None)
  }

  pub fn finish_open(&mut self, _database: Option<PreparedDatabase>) {}

  pub fn write_batch(
    &self,
    writes: impl ParallelIterator<Item = (DatabaseFamily, CacheKey, Vec<u8>)>,
  ) -> Result<usize> {
    Ok(writes.count())
  }

  pub fn key_hash(_key: &CacheKey) -> u64 {
    0
  }
  pub fn write_batch_streamed(
    &self,
    writes: impl ParallelIterator<Item = (DatabaseFamily, CacheKey, Vec<u8>)>,
    topology: impl Iterator<Item = Result<(CacheKey, Vec<u8>)>> + Send,
    metadata: impl FnOnce() -> Result<Vec<(CacheKey, Vec<u8>)>>,
  ) -> Result<usize> {
    let mut count = writes.count();
    for entry in topology {
      entry?;
      count += 1;
    }
    Ok(count + metadata()?.len())
  }

  pub fn compact(&self) -> Result<()> {
    Ok(())
  }

  pub fn has_unrecoverable_write_error(&self) -> bool {
    false
  }

  pub fn reset(&mut self) -> Result<()> {
    Ok(())
  }

  pub fn cleanup_stale(&self) -> Result<()> {
    Ok(())
  }

  pub fn shutdown(self) -> Result<()> {
    Ok(())
  }
}
