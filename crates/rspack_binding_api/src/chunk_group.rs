use std::cell::RefCell;

use napi::{Either, Env, JsString, bindgen_prelude::ToNapiValue};
use napi_derive::napi;
use rspack_core::{Compilation, CompilationId};
use rspack_napi::OneShotRef;
use rustc_hash::FxHashMap;

use crate::{
  chunk::ChunkWrapper,
  location::RealDependencyLocation,
  module::{ModuleObject, ModuleObjectRef},
  with_compilation,
};

#[napi]
pub struct ChunkGroup {
  chunk_group_ukey: rspack_core::ChunkGroupUkey,
  compilation_id: CompilationId,
}

impl ChunkGroup {
  fn with_ref<R>(
    &self,
    f: impl FnOnce(&Compilation, &rspack_core::ChunkGroup) -> napi::Result<R>,
  ) -> napi::Result<R> {
    with_compilation(self.compilation_id, |compilation| {
      if let Some(chunk_group) = compilation
        .build_chunk_graph_artifact
        .chunk_group_by_ukey
        .get(&self.chunk_group_ukey)
      {
        f(compilation, chunk_group)
      } else {
        Err(napi::Error::from_reason(format!(
          "Unable to access chunk_group with id = {:?} now. The chunk group has been removed on the Rust side.",
          self.chunk_group_ukey
        )))
      }
    })
  }
}

#[napi]
impl ChunkGroup {
  #[napi(
    js_name = "_collectionStamp",
    ts_args_type = "kind: 0 | 1 | 2",
    ts_return_type = "number | undefined"
  )]
  pub fn collection_stamp(&self, kind: u32) -> Either<f64, ()> {
    match crate::chunk_collections::stamp(self.compilation_id, kind) {
      Some(stamp) => Either::A(stamp),
      None => Either::B(()),
    }
  }

  #[napi(getter, ts_return_type = "Chunk[]")]
  pub fn chunks(&self) -> napi::Result<Vec<ChunkWrapper>> {
    self.with_ref(|compilation, chunk_group| {
      Ok(
        chunk_group
          .chunks
          .iter()
          .map(|ukey| ChunkWrapper::new(*ukey, compilation))
          .collect::<Vec<_>>(),
      )
    })
  }

  #[napi(getter)]
  pub fn index(&self) -> napi::Result<Either<u32, ()>> {
    self.with_ref(|_, chunk_group| {
      Ok(match chunk_group.index {
        Some(index) => Either::A(index),
        None => Either::B(()),
      })
    })
  }

  #[napi(getter)]
  pub fn name(&self) -> napi::Result<Either<String, ()>> {
    self.with_ref(|_, chunk_group| {
      Ok(match chunk_group.name() {
        Some(name) => Either::A(name.to_string()),
        None => Either::B(()),
      })
    })
  }

  #[napi(getter)]
  pub fn origins<'a>(&self, env: &'a Env) -> napi::Result<Vec<JsChunkGroupOrigin<'a>>> {
    self.with_ref(|compilation, chunk_group| {
      let origins = chunk_group.origins();
      let mut js_origins = Vec::with_capacity(origins.len());

      for origin in origins {
        let loc = if let Some(loc) = &origin.loc {
          Some(match loc {
            rspack_core::DependencyLocation::Real(real) => Either::B(real.into()),
            rspack_core::DependencyLocation::Synthetic(synthetic) => {
              Either::A(env.create_string(&synthetic.name)?)
            }
          })
        } else {
          None
        };

        js_origins.push(JsChunkGroupOrigin {
          module: origin.module.and_then(|module_id| {
            compilation
              .module_by_identifier(&module_id)
              .map(|module| ModuleObject::with_ref(module.as_ref(), compilation.compiler_id()))
          }),
          request: match &origin.request {
            Some(request) => Some(env.create_string(request)?),
            None => None,
          },
          loc,
        })
      }

      Ok(js_origins)
    })
  }

  #[napi(getter, ts_return_type = "ChunkGroup[]")]
  pub fn children_iterable(&self) -> napi::Result<Vec<ChunkGroupWrapper>> {
    self.with_ref(|compilation, chunk_group| {
      Ok(
        chunk_group
          .children_iterable()
          .map(|ukey| ChunkGroupWrapper::new(*ukey, compilation))
          .collect::<Vec<_>>(),
      )
    })
  }

  #[napi]
  pub fn is_initial(&self) -> napi::Result<bool> {
    self.with_ref(|_, chunk_group| Ok(chunk_group.is_initial()))
  }

  #[napi(ts_return_type = "ChunkGroup[]")]
  pub fn get_parents(&self) -> napi::Result<Vec<ChunkGroupWrapper>> {
    self.with_ref(|compilation, chunk_group| {
      Ok(
        chunk_group
          .parents
          .iter()
          .map(|ukey| ChunkGroupWrapper::new(*ukey, compilation))
          .collect(),
      )
    })
  }

  #[napi(ts_return_type = "Chunk")]
  pub fn get_runtime_chunk(&self) -> napi::Result<ChunkWrapper> {
    self.with_ref(|compilation, chunk_group| {
      let chunk_ukey =
        chunk_group.get_runtime_chunk(&compilation.build_chunk_graph_artifact.chunk_group_by_ukey);
      Ok(ChunkWrapper::new(chunk_ukey, compilation))
    })
  }

  #[napi(ts_return_type = "Chunk")]
  pub fn get_entrypoint_chunk(&self) -> napi::Result<ChunkWrapper> {
    self.with_ref(|compilation, chunk_group| {
      let chunk_ukey = chunk_group.get_entrypoint_chunk();
      Ok(ChunkWrapper::new(chunk_ukey, compilation))
    })
  }

  #[napi]
  pub fn get_files(&self) -> napi::Result<Vec<String>> {
    self.with_ref(|compilation, chunk_group| {
      Ok(
        chunk_group
          .chunks
          .iter()
          .filter_map(|chunk_ukey| {
            compilation
              .build_chunk_graph_artifact
              .chunk_by_ukey
              .get(chunk_ukey)
              .map(|chunk| chunk.files().iter())
          })
          .flatten()
          .cloned()
          .collect::<Vec<_>>(),
      )
    })
  }

  #[napi(ts_args_type = "module: Module")]
  pub fn get_module_pre_order_index(&self, module: ModuleObjectRef) -> napi::Result<Option<u32>> {
    self.with_ref(|_, chunk_group| Ok(chunk_group.module_pre_order_index(&module.identifier)))
  }

  #[napi(ts_args_type = "module: Module")]
  pub fn get_module_post_order_index(&self, module: ModuleObjectRef) -> napi::Result<Option<u32>> {
    self.with_ref(|_, chunk_group| Ok(chunk_group.module_post_order_index(&module.identifier)))
  }
}

thread_local! {
  static CHUNK_GROUP_INSTANCE_REFS: RefCell<FxHashMap<CompilationId, crate::chunk_collections::InstanceRefs<rspack_core::ChunkGroupUkey>>> = Default::default();
}

pub struct ChunkGroupWrapper {
  chunk_group_ukey: rspack_core::ChunkGroupUkey,
  compilation_id: CompilationId,
}

impl ChunkGroupWrapper {
  pub fn new(chunk_group_ukey: rspack_core::ChunkGroupUkey, compilation: &Compilation) -> Self {
    Self {
      chunk_group_ukey,
      compilation_id: compilation.id(),
    }
  }

  pub(crate) fn generation(compilation_id: CompilationId) -> Option<u64> {
    CHUNK_GROUP_INSTANCE_REFS.with(|refs| {
      refs
        .borrow()
        .get(&compilation_id)
        .map(|refs| refs.generation())
    })
  }

  pub fn cleanup_last_compilation(compilation_id: CompilationId) {
    let removed = CHUNK_GROUP_INSTANCE_REFS.with(|refs| refs.borrow_mut().remove(&compilation_id));
    drop(removed);
  }
}

impl ToNapiValue for ChunkGroupWrapper {
  unsafe fn to_napi_value(
    env: napi::sys::napi_env,
    val: Self,
  ) -> napi::Result<napi::sys::napi_value> {
    if let Some(value) = CHUNK_GROUP_INSTANCE_REFS
      .with(|refs| {
        refs
          .borrow()
          .get(&val.compilation_id)
          .map(|refs| unsafe { refs.get(env, &val.chunk_group_ukey) })
          .transpose()
      })?
      .flatten()
    {
      return Ok(value);
    }
    // Allocation can re-enter JS: do not hold either map borrow here.
    let value = unsafe {
      OneShotRef::new(
        env,
        ChunkGroup {
          chunk_group_ukey: val.chunk_group_ukey,
          compilation_id: val.compilation_id,
        },
      )?
    };
    CHUNK_GROUP_INSTANCE_REFS.with(|refs| {
      let mut refs = refs.borrow_mut();
      let refs = refs.entry(val.compilation_id).or_default();
      unsafe { refs.get_or_insert(env, val.chunk_group_ukey, value) }
    })
  }
}

#[napi(object, object_from_js = false)]
pub struct JsChunkGroupOrigin<'a> {
  #[napi(ts_type = "Module | undefined")]
  pub module: Option<ModuleObject>,
  pub request: Option<JsString<'a>>,
  pub loc: Option<Either<JsString<'a>, RealDependencyLocation>>,
}
