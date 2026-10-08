use napi::{
  Env, JsValue, Unknown,
  bindgen_prelude::{FromNapiValue, JsObjectValue, Object},
  sys,
};
use rspack_core::{ChunkUkey, Compilation};
use rspack_error::Result;
use rspack_napi::{NapiErrorToRspackErrorExt, threadsafe_function::pretty_type_error};
use rustc_hash::FxHashMap;

use crate::chunk::ChunkWrapper;

pub struct JsBatchResult<T>(pub Vec<Result<T>>);

impl<T: FromNapiValue> FromNapiValue for JsBatchResult<T> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
    // Conversion runs in the TSFN return callback on its owning JavaScript thread.
    let object = unsafe { Object::from_napi_value(env, value)? };
    let (results, thrown, mut error) = if object.is_array()? {
      (object, Vec::new(), None)
    } else {
      let results: Object = object.get_named_property("results")?;
      let thrown: Vec<u32> = object.get_named_property("thrown")?;
      let error: Unknown = object.get_named_property("error")?;
      (
        results,
        thrown,
        Some(napi::Error::from(error).to_rspack_error(&Env::from_raw(env))),
      )
    };
    let mut items = Vec::with_capacity(results.get_array_length()? as usize);
    let mut thrown = thrown.into_iter().peekable();
    for index in 0..results.get_array_length()? {
      if thrown.peek() == Some(&index) {
        thrown.next();
        // The first thrown item is the lowest-index failure in this batch.
        // Later failures only stop their modules and cannot win error precedence.
        items.push(Err(error.take().unwrap_or_default()));
      } else {
        let item: Unknown = results.get_element(index)?;
        items.push(
          unsafe { T::from_napi_value(env, item.raw()) }.map_err(|e| pretty_type_error(item, e)),
        );
      }
    }
    Ok(Self(items))
  }
}

const CHUNK_DEDUP_HASH_THRESHOLD: usize = 16;

pub(super) struct ChunkTable<'a> {
  compilation: &'a Compilation,
  keys: Vec<ChunkUkey>,
  indices: Option<FxHashMap<ChunkUkey, u32>>,
  pub chunks: Vec<ChunkWrapper>,
}

impl<'a> ChunkTable<'a> {
  pub fn new(compilation: &'a Compilation, references: usize) -> Self {
    Self {
      compilation,
      keys: Vec::with_capacity(references.min(CHUNK_DEDUP_HASH_THRESHOLD)),
      indices: None,
      chunks: Vec::with_capacity(references.min(CHUNK_DEDUP_HASH_THRESHOLD)),
    }
  }

  pub fn index(&mut self, chunk: ChunkUkey) -> u32 {
    if let Some(indices) = &mut self.indices {
      *indices.entry(chunk).or_insert_with(|| {
        let index = self.chunks.len() as u32;
        self.chunks.push(ChunkWrapper::new(chunk, self.compilation));
        index
      })
    } else if let Some(index) = self.keys.iter().position(|item| *item == chunk) {
      index as u32
    } else {
      let index = self.chunks.len() as u32;
      self.keys.push(chunk);
      self.chunks.push(ChunkWrapper::new(chunk, self.compilation));
      if self.keys.len() == CHUNK_DEDUP_HASH_THRESHOLD {
        self.indices = Some(
          self
            .keys
            .iter()
            .enumerate()
            .map(|(index, chunk)| (*chunk, index as u32))
            .collect(),
        );
      }
      index
    }
  }
}
