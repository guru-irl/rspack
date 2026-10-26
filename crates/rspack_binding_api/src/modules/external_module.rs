use napi::{
  CallContext, JsObject, JsString, NapiRaw,
  bindgen_prelude::{FromNapiMutRef, Object},
};

use crate::{
  impl_module_methods,
  module::{MODULE_PROPERTIES_BUFFER, Module},
  shared_properties::define_shared_properties,
};

#[napi]
#[repr(C)]
pub struct ExternalModule {
  pub(crate) module: Module,
}

impl ExternalModule {
  pub(crate) fn into_module_instance(
    self,
    env: &napi::Env,
  ) -> napi::Result<napi::bindgen_prelude::ClassInstance<'_, Self>> {
    MODULE_PROPERTIES_BUFFER.with(|ref_cell| {
      let mut properties = ref_cell.borrow_mut();
      properties.clear();
      Self::new_inherited(self, env, &mut properties)
    })
  }

  fn define_shared_properties(env: &napi::Env, object: Object<'_>) -> napi::Result<()> {
    #[js_function]
    fn user_request_getter(ctx: CallContext<'_>) -> napi::Result<JsString<'_>> {
      let this = ctx.this_unchecked::<JsObject>();
      let wrapped_value = unsafe { ExternalModule::from_napi_mut_ref(ctx.env.raw(), this.raw())? };
      wrapped_value.module.record_untrackable_read();
      wrapped_value.with_ref(|_, module| ctx.env.create_string(module.user_request()))
    }
    define_shared_properties::<Self>(env, object, || {
      Ok(vec![
        napi::Property::new()
          .with_utf8_name("userRequest")?
          .with_getter(user_request_getter),
      ])
    })
  }

  fn with_ref<R>(
    &mut self,
    f: impl FnOnce(&rspack_core::Compilation, &rspack_core::ExternalModule) -> napi::Result<R>,
  ) -> napi::Result<R> {
    self
      .module
      .with_ref(|compilation, module| match module.as_external_module() {
        Some(external_module) => f(compilation, external_module),
        None => Err(napi::Error::new(
          napi::Status::GenericFailure,
          "Module is not a ExternalModule",
        )),
      })
  }
}

impl_module_methods!(ExternalModule, ExternalModule::define_shared_properties);
