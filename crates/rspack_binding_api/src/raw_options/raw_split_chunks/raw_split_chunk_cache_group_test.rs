use std::sync::Arc;

use napi::bindgen_prelude::Either3;
use napi_derive::napi;
use rspack_plugin_split_chunks::{CacheGroupTest, CacheGroupTestFnCtx, SplitChunksTestBatchFn};
use rspack_regex::RspackRegex;

use crate::{
  compiler_scoped_tsfn::CompilerScopedTsFnHandle as ThreadsafeFunction, module::ModuleObject,
};

pub(super) type RawCacheGroupTest =
  Either3<String, RspackRegex, ThreadsafeFunction<JsCacheGroupTestCtx, Option<bool>>>;

#[napi(object, object_from_js = false)]
pub struct JsCacheGroupTestCtx {
  #[napi(ts_type = "Module")]
  pub module: ModuleObject,
}

impl<'a> From<CacheGroupTestFnCtx<'a>> for JsCacheGroupTestCtx {
  fn from(value: CacheGroupTestFnCtx<'a>) -> Self {
    JsCacheGroupTestCtx {
      module: ModuleObject::with_ref(value.module, value.compilation.compiler_id()),
    }
  }
}

pub(super) fn normalize_raw_cache_group_test(raw: RawCacheGroupTest) -> CacheGroupTest {
  match raw {
    Either3::A(str) => CacheGroupTest::String(str),
    Either3::B(regexp) => CacheGroupTest::RegExp(regexp),
    Either3::C(v) => CacheGroupTest::Fn(Arc::new(move |ctx| {
      let ctx = ctx.into();
      let v = v.clone();
      Box::pin(async move { v.call_with_sync(ctx).await })
    })),
  }
}

#[inline]
pub(super) fn default_cache_group_test() -> CacheGroupTest {
  CacheGroupTest::Enabled
}

pub(super) type RawCacheGroupTestBatch =
  ThreadsafeFunction<Vec<ModuleObject>, super::batch::JsBatchResult<Option<bool>>>;

pub(super) fn normalize_raw_cache_group_test_batch(
  raw: RawCacheGroupTestBatch,
) -> SplitChunksTestBatchFn {
  Arc::new(move |contexts| {
    let modules = contexts
      .into_iter()
      .map(|ctx| ModuleObject::with_ref(ctx.module, ctx.compilation.compiler_id()))
      .collect();
    let raw = raw.clone();
    Box::pin(async move { raw.call_with_sync(modules).await.map(|result| result.0) })
  })
}

pub(super) fn test_batch_adapter(getter: &SplitChunksTestBatchFn) -> CacheGroupTest {
  let getter = Arc::clone(getter);
  CacheGroupTest::Fn(Arc::new(move |ctx| {
    let result = getter(vec![ctx]);
    Box::pin(async move {
      result
        .await?
        .pop()
        .expect("single-item batch should have one result")
    })
  }))
}
