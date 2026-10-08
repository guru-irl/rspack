use std::sync::Arc;

use futures::future::BoxFuture;
use itertools::Either;
use rspack_core::{ChunkUkey, Compilation, Module};
use rspack_error::Result;
use rustc_hash::FxHashSet;

pub struct ChunkNameGetterFnCtx<'a> {
  pub module: &'a dyn Module,
  pub compilation: &'a Compilation,
  pub chunks: &'a Vec<ChunkUkey>,
  pub cache_group_key: &'a str,
}

type ChunkNameGetterFn = Arc<
  dyn for<'a> Fn(ChunkNameGetterFnCtx<'a>) -> BoxFuture<'static, Result<Option<String>>>
    + Sync
    + Send,
>;

#[derive(Clone)]
pub enum ChunkNameGetter {
  String(String),
  Fn(ChunkNameGetterFn),
  Disabled,
}

// Borrow the existing selection for batch transport. Scalar Rust callbacks keep
// their original Vec context and per-module error semantics.
#[doc(hidden)]
pub struct ChunkNameBatchGetterFnCtx<'a> {
  pub module: &'a dyn Module,
  pub compilation: &'a Compilation,
  pub chunks: Either<&'a [ChunkUkey], &'a FxHashSet<ChunkUkey>>,
  pub cache_group_key: &'a str,
}

impl ChunkNameBatchGetterFnCtx<'_> {
  pub fn chunks_len(&self) -> usize {
    match self.chunks {
      Either::Left(chunks) => chunks.len(),
      Either::Right(chunks) => chunks.len(),
    }
  }

  pub fn chunks_iter(&self) -> impl Iterator<Item = &ChunkUkey> {
    match self.chunks {
      Either::Left(chunks) => Either::Left(chunks.iter()),
      Either::Right(chunks) => Either::Right(chunks.iter()),
    }
  }
}
