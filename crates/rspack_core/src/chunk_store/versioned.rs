use std::sync::atomic::{AtomicU64, Ordering};

const MAX_TOKEN: u64 = (1 << 53) - 1;
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// Internal collection validity numbers. Zero permanently disables caching on exhaustion.
#[doc(hidden)]
pub fn chunk_collection_token() -> u64 {
  NEXT_TOKEN
    .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |token| {
      (token <= MAX_TOKEN).then_some(token + 1)
    })
    .unwrap_or(0)
}

/// The map is private in this leaf module, so both stores share exactly one
/// mutable gateway. A unique creation id and local version move with the store:
/// whole-store swap, take and assignment preserve validity without making
/// artifact fields private. Mutable access is exclusive, so version increments
/// need no atomics. Exhausted versions disable caching rather than wrap.
/// Existing incremental graph recovery needs map clones; they receive fresh
/// ids. No new graph copies are introduced.
/// The binding audit found no current in-tap API that holds a mutable chunk or
/// group borrow across JavaScript reads. New binding APIs must preserve that
/// access-window rule; this stamp is not graph synchronization.
#[derive(Debug)]
pub(super) struct Versioned<M> {
  map: M,
  id: u64,
  version: u64,
}

impl<M> Versioned<M> {
  pub(super) fn map(&self) -> &M {
    &self.map
  }
  pub(super) fn map_mut(&mut self) -> &mut M {
    self.version = self.version.saturating_add(1);
    &mut self.map
  }
  pub(super) fn stamp(&self) -> Option<(u64, u64)> {
    (self.id != 0 && self.version != u64::MAX).then_some((self.id, self.version))
  }
}

impl<M: Default> Default for Versioned<M> {
  fn default() -> Self {
    Self {
      map: M::default(),
      id: chunk_collection_token(),
      version: 0,
    }
  }
}

impl<M: Clone> Clone for Versioned<M> {
  fn clone(&self) -> Self {
    Self {
      map: self.map.clone(),
      id: chunk_collection_token(),
      version: 0,
    }
  }
}
