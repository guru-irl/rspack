use std::sync::atomic::{AtomicU64, Ordering};

const MAX_TOKEN: u64 = (1 << 53) - 1;
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// Internal collection validity numbers. Zero permanently disables caching on exhaustion.
#[doc(hidden)]
pub fn chunk_collection_token() -> u64 {
  NEXT_TOKEN
    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |token| {
      (token <= MAX_TOKEN).then_some(token + 1)
    })
    .unwrap_or(0)
}

/// The map is private in this leaf module, so both stores share exactly one
/// mutable gateway. Tokens move with the store: whole-store swap, take and
/// assignment preserve validity without making artifact fields private.
/// Existing incremental graph recovery needs map clones; they receive fresh
/// tokens. No new graph copies are introduced.
/// The binding audit found no current in-tap API that holds a mutable chunk or
/// group borrow across JavaScript reads. New binding APIs must preserve that
/// access-window rule; this token is not graph synchronization.
#[derive(Debug)]
pub(super) struct Versioned<M> {
  map: M,
  token: u64,
}

impl<M> Versioned<M> {
  pub(super) fn map(&self) -> &M {
    &self.map
  }
  pub(super) fn map_mut(&mut self) -> &mut M {
    self.token = chunk_collection_token();
    &mut self.map
  }
  pub(super) fn token(&self) -> u64 {
    self.token
  }
}

impl<M: Default> Default for Versioned<M> {
  fn default() -> Self {
    Self {
      map: M::default(),
      token: chunk_collection_token(),
    }
  }
}

impl<M: Clone> Clone for Versioned<M> {
  fn clone(&self) -> Self {
    Self {
      map: self.map.clone(),
      token: chunk_collection_token(),
    }
  }
  fn clone_from(&mut self, source: &Self) {
    self.map_mut().clone_from(&source.map);
  }
}
