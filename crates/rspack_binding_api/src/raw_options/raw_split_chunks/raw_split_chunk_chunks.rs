use std::sync::Arc;

use napi::{
  JsString,
  bindgen_prelude::{Either3, Uint32Array},
};
use napi_derive::napi;
use rspack_core::{ChunkUkey, Compilation};
use rspack_napi::string::JsStringExt;
use rspack_plugin_split_chunks::{
  ChunkFilter, SplitChunksChunksBatchFn, create_chunk_filter_from_str,
  create_regex_chunk_filter_from_str,
};
use rspack_regex::RspackRegex;

use crate::{
  chunk::ChunkWrapper, compiler_scoped_tsfn::CompilerScopedTsFnHandle as ThreadsafeFunction,
};

pub type Chunks<'a> = Either3<RspackRegex, JsString<'a>, ThreadsafeFunction<ChunkWrapper, bool>>;

pub fn create_chunks_filter(raw: Chunks) -> ChunkFilter {
  match raw {
    Either3::A(regex) => create_regex_chunk_filter_from_str(regex),
    Either3::B(js_str) => {
      let js_str = js_str.into_string();
      create_chunk_filter_from_str(&js_str)
    }
    Either3::C(f) => ChunkFilter::Func(Arc::new(move |chunk_ukey, compilation| {
      let f = f.clone();
      let chunk_wrapper = ChunkWrapper::new(*chunk_ukey, compilation);
      Box::pin(async move { f.call_with_sync(chunk_wrapper).await })
    })),
  }
}

#[napi(object, object_from_js = false)]
pub struct JsChunksFilterBatch {
  #[napi(ts_type = "Chunk[]")]
  pub chunks: Vec<ChunkWrapper>,
  pub chunk_indices: Uint32Array,
}

pub(super) type RawChunksFilterBatch =
  ThreadsafeFunction<JsChunksFilterBatch, super::batch::JsBatchResult<bool>>;

pub(super) fn normalize_raw_chunks_filter_batch(
  raw: RawChunksFilterBatch,
) -> SplitChunksChunksBatchFn {
  Arc::new(move |chunks: &[ChunkUkey], compilation: &Compilation| {
    let mut table = super::batch::ChunkTable::new(compilation, chunks.len());
    let chunk_indices = chunks
      .iter()
      .map(|chunk| table.index(*chunk))
      .collect::<Vec<_>>()
      .into();
    let batch = JsChunksFilterBatch {
      chunks: table.chunks,
      chunk_indices,
    };
    let raw = raw.clone();
    Box::pin(async move { raw.call_with_sync(batch).await.map(|result| result.0) })
  })
}

pub(super) fn chunks_batch_adapter(getter: &SplitChunksChunksBatchFn) -> ChunkFilter {
  let getter = Arc::clone(getter);
  ChunkFilter::Func(Arc::new(move |chunk, compilation| {
    let result = getter(&[*chunk], compilation);
    Box::pin(async move {
      result
        .await?
        .pop()
        .expect("single-item batch should have one result")
    })
  }))
}
