use napi::{
  Env, JsValue, Unknown,
  bindgen_prelude::{FromNapiValue, JsObjectValue, Object},
  sys,
};
use rspack_error::Result;
use rspack_napi::{NapiErrorToRspackErrorExt, threadsafe_function::pretty_type_error};

pub struct JsBatchResult<T>(pub Vec<Result<T>>);

impl<T: FromNapiValue> FromNapiValue for JsBatchResult<T> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
    let object = unsafe { Object::from_napi_value(env, value)? };
    let (results, thrown, error) = if object.is_array()? {
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
    let length = results.get_array_length()?;
    let mut items = Vec::with_capacity(length as usize);
    let mut thrown = thrown.into_iter().peekable();
    for index in 0..length {
      if thrown.peek() == Some(&index) {
        thrown.next();
        items.push(Err(error.clone().ok_or_else(|| {
          napi::Error::from_reason("test batch is missing its thrown error")
        })?));
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
