mod versioned;

use rustc_hash::FxHashMap;
pub use versioned::chunk_collection_token;

use crate::{Chunk, ChunkGroup, ChunkGroupUkey, ChunkUkey};

#[derive(Debug, Default, Clone)]
pub struct ChunkByUkey {
  inner: versioned::Versioned<FxHashMap<ChunkUkey, Chunk>>,
}

impl ChunkByUkey {
  #[doc(hidden)]
  pub fn collection_stamp(&self) -> Option<(u64, u64)> {
    self.inner.stamp()
  }

  pub(crate) fn reserve_capacity(&mut self, total: usize) {
    let additional = total.saturating_sub(self.inner.map().len());
    self.inner.map_mut().reserve(additional);
  }

  pub fn get(&self, ukey: &ChunkUkey) -> Option<&Chunk> {
    self.inner.map().get(ukey)
  }

  pub fn get_mut(&mut self, ukey: &ChunkUkey) -> Option<&mut Chunk> {
    self.inner.map_mut().get_mut(ukey)
  }

  pub fn get_many_mut<const N: usize>(
    &mut self,
    ukeys: [&ChunkUkey; N],
  ) -> [Option<&mut Chunk>; N] {
    self.inner.map_mut().get_disjoint_mut(ukeys)
  }

  pub fn expect_get(&self, ukey: &ChunkUkey) -> &Chunk {
    self
      .get(ukey)
      .unwrap_or_else(|| panic!("Chunk({ukey:?}) not found in ChunkByUkey"))
  }

  pub fn expect_get_mut(&mut self, ukey: &ChunkUkey) -> &mut Chunk {
    self
      .get_mut(ukey)
      .unwrap_or_else(|| panic!("Chunk({ukey:?}) not found in ChunkByUkey"))
  }

  pub fn add(&mut self, chunk: Chunk) -> &mut Chunk {
    let ukey = chunk.ukey();
    debug_assert!(!self.inner.map().contains_key(&ukey));
    self.inner.map_mut().entry(ukey).or_insert(chunk)
  }

  pub fn remove(&mut self, ukey: &ChunkUkey) -> Option<Chunk> {
    self.inner.map_mut().remove(ukey)
  }

  pub fn entry(
    &mut self,
    ukey: ChunkUkey,
  ) -> std::collections::hash_map::Entry<'_, ChunkUkey, Chunk> {
    self.inner.map_mut().entry(ukey)
  }

  pub fn contains(&self, ukey: &ChunkUkey) -> bool {
    self.inner.map().contains_key(ukey)
  }

  pub fn keys(&self) -> impl Iterator<Item = &ChunkUkey> {
    self.inner.map().keys()
  }

  pub fn values(&self) -> impl Iterator<Item = &Chunk> {
    self.inner.map().values()
  }

  pub fn values_mut(&mut self) -> impl Iterator<Item = &mut Chunk> {
    self.inner.map_mut().values_mut()
  }

  pub fn iter(&self) -> impl Iterator<Item = (&ChunkUkey, &Chunk)> {
    self.inner.map().iter()
  }

  pub fn iter_mut(&mut self) -> impl Iterator<Item = (&ChunkUkey, &mut Chunk)> {
    self.inner.map_mut().iter_mut()
  }

  #[allow(clippy::len_without_is_empty)]
  pub fn len(&self) -> usize {
    self.inner.map().len()
  }
}

#[derive(Debug, Default, Clone)]
pub struct ChunkGroupByUkey {
  inner: versioned::Versioned<FxHashMap<ChunkGroupUkey, ChunkGroup>>,
}

impl ChunkGroupByUkey {
  #[doc(hidden)]
  pub fn collection_stamp(&self) -> Option<(u64, u64)> {
    self.inner.stamp()
  }

  pub(crate) fn reserve_capacity(&mut self, total: usize) {
    let additional = total.saturating_sub(self.inner.map().len());
    self.inner.map_mut().reserve(additional);
  }

  pub fn get(&self, ukey: &ChunkGroupUkey) -> Option<&ChunkGroup> {
    self.inner.map().get(ukey)
  }

  pub fn get_mut(&mut self, ukey: &ChunkGroupUkey) -> Option<&mut ChunkGroup> {
    self.inner.map_mut().get_mut(ukey)
  }

  pub fn expect_get(&self, ukey: &ChunkGroupUkey) -> &ChunkGroup {
    self
      .get(ukey)
      .unwrap_or_else(|| panic!("ChunkGroup({ukey:?}) not found in ChunkGroupByUkey"))
  }

  pub fn expect_get_mut(&mut self, ukey: &ChunkGroupUkey) -> &mut ChunkGroup {
    self
      .get_mut(ukey)
      .unwrap_or_else(|| panic!("ChunkGroup({ukey:?}) not found in ChunkGroupByUkey"))
  }

  pub fn add(&mut self, chunk: ChunkGroup) -> &mut ChunkGroup {
    let ukey = chunk.ukey();
    debug_assert!(!self.inner.map().contains_key(&ukey));
    self.inner.map_mut().entry(ukey).or_insert(chunk)
  }

  pub fn remove(&mut self, ukey: &ChunkGroupUkey) -> Option<ChunkGroup> {
    self.inner.map_mut().remove(ukey)
  }

  pub fn contains(&self, ukey: &ChunkGroupUkey) -> bool {
    self.inner.map().contains_key(ukey)
  }

  pub fn keys(&self) -> impl Iterator<Item = &ChunkGroupUkey> {
    self.inner.map().keys()
  }

  pub fn values(&self) -> impl Iterator<Item = &ChunkGroup> {
    self.inner.map().values()
  }

  pub fn iter(&self) -> impl Iterator<Item = (&ChunkGroupUkey, &ChunkGroup)> {
    self.inner.map().iter()
  }
}
