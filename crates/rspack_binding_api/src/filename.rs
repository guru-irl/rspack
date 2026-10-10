use std::{fmt::Debug, sync::Arc};

use futures::future::BoxFuture;
use napi::{
  Either,
  bindgen_prelude::{FnArgs, FromNapiValue, TypeName},
};
use rspack_core::{Filename, FilenameFn, LocalFilenameFn, PathData, PublicPath};
use rspack_error::error;

use crate::{
  asset::AssetInfo, compiler_scoped_tsfn::CompilerScopedTsFnHandle as ThreadsafeFunction,
  path_data::JsPathData,
};

pub(crate) type FilenameBatchTsfn = ThreadsafeFunction<FnArgs<(Vec<JsPathData>,)>, Vec<String>>;

type FilenameValue =
  Either<String, ThreadsafeFunction<FnArgs<(JsPathData, Option<AssetInfo>)>, String>>;

/// A js filename value. Either a string or a function
#[derive(Debug)]
pub struct JsFilename {
  pub filename: FilenameValue,
}

impl FromNapiValue for JsFilename {
  unsafe fn from_napi_value(
    env: napi::sys::napi_env,
    napi_val: napi::sys::napi_value,
  ) -> napi::Result<Self> {
    unsafe {
      Ok(Self {
        filename: Either::from_napi_value(env, napi_val)?,
      })
    }
  }
}

impl TypeName for JsFilename {
  fn type_name() -> &'static str {
    "JsFilename"
  }

  fn value_type() -> napi::ValueType {
    napi::ValueType::Unknown
  }
}

impl JsFilename {
  pub(crate) fn into_filename(self, batch: Option<FilenameBatchTsfn>) -> Filename {
    match self.filename {
      Either::A(template) => Filename::from(template),
      Either::B(f) => Filename::from(Arc::new(ThreadSafeFilenameFn(
        Arc::new(move |path_data, asset_info| {
          let f = f.clone();
          Box::pin(async move { f.call_with_sync((path_data, asset_info).into()).await })
        }),
        batch,
      )) as Arc<dyn FilenameFn>),
    }
  }
}

impl From<JsFilename> for Filename {
  fn from(value: JsFilename) -> Self {
    value.into_filename(None)
  }
}

impl From<JsFilename> for PublicPath {
  fn from(value: JsFilename) -> Self {
    match value.filename {
      Either::A(template) => template.into(),
      Either::B(f) => PublicPath::Filename(Filename::from(Arc::new(ThreadSafeFilenameFn(
        Arc::new(move |path_data, asset_info| {
          let f = f.clone();
          Box::pin(async move { f.call_with_sync((path_data, asset_info).into()).await })
        }),
        None,
      )) as Arc<dyn FilenameFn>)),
    }
  }
}

pub type FilenameTsfn = Arc<
  dyn Fn(JsPathData, Option<AssetInfo>) -> BoxFuture<'static, rspack_error::Result<String>>
    + Sync
    + Send,
>;

/// Wrapper of a thread-safe filename js function. Implements `FilenameFn`
struct ThreadSafeFilenameFn(FilenameTsfn, Option<FilenameBatchTsfn>);

impl Debug for ThreadSafeFilenameFn {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ThreadSafeFilenameFn").finish()
  }
}

#[async_trait::async_trait]
impl LocalFilenameFn for ThreadSafeFilenameFn {
  async fn call(
    &self,
    path_data: &PathData,
    asset_info: Option<&rspack_core::AssetInfo>,
  ) -> rspack_error::Result<String> {
    (self.0)(
      JsPathData::from_path_data(*path_data),
      asset_info.cloned().map(AssetInfo::from),
    )
    .await
  }
}
#[async_trait::async_trait]
impl FilenameFn for ThreadSafeFilenameFn {
  async fn call_batch(&self, path_data: &[PathData<'_>]) -> rspack_error::Result<Vec<String>> {
    if let Some(batch) = &self.1 {
      let paths = path_data
        .iter()
        .map(|data| JsPathData::from_path_data(*data))
        .collect::<Vec<_>>();
      let count = paths.len();
      let filenames = batch.call_with_sync((paths,).into()).await?;
      if filenames.len() != count {
        return Err(error!(
          "Filename batch should return one filename per request"
        ));
      }
      return Ok(filenames);
    }
    let mut filenames = Vec::with_capacity(path_data.len());
    for path_data in path_data {
      filenames.push(self.call(path_data, None).await?);
    }
    Ok(filenames)
  }

  fn supports_batch(&self) -> bool {
    self.1.is_some()
  }
}
