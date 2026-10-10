use std::{cell::RefCell, hash::Hash};

use napi::{
  bindgen_prelude::{ToNapiValue, WeakReference},
  sys,
};
use rspack_core::{CompilationId, chunk_collection_token};
use rspack_napi::OneShotRef;
use rustc_hash::FxHashMap;

use crate::{COMPILER_REFERENCES, JsCompiler, chunk::ChunkWrapper, chunk_group::ChunkGroupWrapper};

/// No raw mutable map escapes: insertion preserves existing identity. Removing
/// a whole map drops its generation, and constructing its replacement remints it.
/// Future per-entry removal must likewise remint the generation.
pub(crate) struct InstanceRefs<K> {
  generation: u64,
  refs: FxHashMap<K, OneShotRef>,
}

impl<K: Eq + Hash> Default for InstanceRefs<K> {
  fn default() -> Self {
    Self {
      generation: chunk_collection_token(),
      refs: FxHashMap::default(),
    }
  }
}

impl<K: Eq + Hash> InstanceRefs<K> {
  pub(crate) fn generation(&self) -> u64 {
    self.generation
  }
  pub(crate) unsafe fn get(
    &self,
    env: sys::napi_env,
    key: &K,
  ) -> napi::Result<Option<sys::napi_value>> {
    self
      .refs
      .get(key)
      .map(|value| unsafe { ToNapiValue::to_napi_value(env, value) })
      .transpose()
  }
  pub(crate) unsafe fn get_or_insert(
    &mut self,
    env: sys::napi_env,
    key: K,
    value: OneShotRef,
  ) -> napi::Result<sys::napi_value> {
    unsafe { ToNapiValue::to_napi_value(env, &*self.refs.entry(key).or_insert(value)) }
  }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Tuple((u64, u64), (u64, u64), u64);
struct Observed {
  tuple: Tuple,
  number: u64,
}
struct Owner {
  compiler: WeakReference<JsCompiler>,
  observed: [Option<Observed>; 3],
}

thread_local! {
  static OWNERS: RefCell<FxHashMap<CompilationId, Owner>> = RefCell::default();
}

pub(crate) fn cleanup(id: CompilationId) {
  // Drop weak handles outside the registry borrow.
  let owner = OWNERS.with(|owners| owners.borrow_mut().remove(&id));
  drop(owner);
}

pub(crate) fn stamp(id: CompilationId, kind: u32) -> Option<f64> {
  if kind > 2 {
    return None;
  }
  let present = OWNERS.with(|owners| owners.borrow().contains_key(&id));
  if !present {
    // Exactly main's successful owner selection, only on the first miss.
    let reference = COMPILER_REFERENCES.with(|references| {
      references
        .borrow()
        .values()
        .find(|reference| {
          reference
            .get()
            .is_some_and(|compiler| compiler.compiler.compilation.id() == id)
        })
        .cloned()
    })?;
    if reference.get()?.compiler.compilation.id() != id {
      return None;
    }
    OWNERS.with(|owners| {
      owners.borrow_mut().insert(
        id,
        Owner {
          compiler: reference,
          observed: [None, None, None],
        },
      );
    });
  }
  OWNERS.with(|owners| {
    let mut owners = owners.borrow_mut();
    let owner = owners.get_mut(&id)?;
    let compiler = owner.compiler.get()?;
    let compilation = &compiler.compiler.compilation;
    if compilation.id() != id {
      return None;
    }
    let stores = &compilation.build_chunk_graph_artifact;
    let tuple = match kind {
      0 => Tuple(stores.chunk_by_ukey.collection_stamp()?, (0, 0), 0),
      1 => Tuple(
        stores.chunk_by_ukey.collection_stamp()?,
        stores.chunk_group_by_ukey.collection_stamp()?,
        ChunkGroupWrapper::generation(id)?,
      ),
      _ => Tuple(
        stores.chunk_group_by_ukey.collection_stamp()?,
        (0, 0),
        ChunkWrapper::generation(id)?,
      ),
    };
    if kind != 0 && tuple.2 == 0 {
      return None;
    }
    let observed = &mut owner.observed[kind as usize];
    if let Some(observed) = observed.as_ref()
      && observed.tuple == tuple
    {
      return Some(observed.number as f64);
    }
    let number = chunk_collection_token();
    if number == 0 {
      return None;
    }
    *observed = Some(Observed { tuple, number });
    Some(number as f64)
  })
}
