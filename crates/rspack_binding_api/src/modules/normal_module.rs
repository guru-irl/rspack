use napi::{
  CallContext, Either, JsObject, JsString, NapiRaw,
  bindgen_prelude::{FromNapiMutRef, JsObjectValue, Object, ToNapiValue},
};
use rspack_core::{ResourceData, ResourceParsedData, parse_resource};
use rspack_error::Diagnosable;

use crate::{
  diagnostic,
  error::RspackError,
  impl_module_methods,
  module::{MODULE_PROPERTIES_BUFFER, Module},
  plugins::JsLoaderItem,
  resource_data::ReadonlyResourceDataWrapper,
  shared_properties::define_shared_properties,
};

#[napi]
#[repr(C)]
pub struct NormalModule {
  pub(crate) module: Module,
}

impl NormalModule {
  pub fn new(module: Module) -> Self {
    Self { module }
  }

  pub(crate) fn into_module_instance(
    mut self,
    env: &napi::Env,
  ) -> napi::Result<napi::bindgen_prelude::ClassInstance<'_, Self>> {
    let (resource_resolve_data, loaders) = self.with_ref(|_, module| {
      let resource_resolved_data = module.resource_resolved_data();
      let resource_resolve_data = Object::from_raw(env.raw(), unsafe {
        ToNapiValue::to_napi_value(
          env.raw(),
          ReadonlyResourceDataWrapper::from(resource_resolved_data.clone()),
        )?
      });
      let loaders = Object::from_raw(env.raw(), unsafe {
        ToNapiValue::to_napi_value(
          env.raw(),
          module
            .loaders()
            .iter()
            .map(JsLoaderItem::from)
            .collect::<Vec<_>>(),
        )?
      });

      Ok((resource_resolve_data, loaders))
    })?;

    let instance = MODULE_PROPERTIES_BUFFER.with(|ref_cell| {
      let mut properties = ref_cell.borrow_mut();
      properties.clear();
      Self::new_inherited(self, env, &mut properties)
    })?;
    let object = instance.as_object(env);
    crate::module_object_state::set(env, object, "resourceResolveData", resource_resolve_data)?;
    crate::module_object_state::set(env, object, "loaders", loaders)?;
    Ok(instance)
  }

  fn define_shared_properties(env: &napi::Env, object: Object<'_>) -> napi::Result<()> {
    #[js_function]
    fn request_getter(ctx: CallContext<'_>) -> napi::Result<JsString<'_>> {
      let this = ctx.this_unchecked::<JsObject>();
      let wrapped_value = unsafe { NormalModule::from_napi_mut_ref(ctx.env.raw(), this.raw())? };
      wrapped_value.module.record_untrackable_read();
      wrapped_value.with_ref(|_, module| ctx.env.create_string(module.request()))
    }

    #[js_function]
    fn user_request_getter(ctx: CallContext<'_>) -> napi::Result<JsString<'_>> {
      let this = ctx.this_unchecked::<JsObject>();
      let wrapped_value = unsafe { NormalModule::from_napi_mut_ref(ctx.env.raw(), this.raw())? };
      wrapped_value.module.record_untrackable_read();
      wrapped_value.with_ref(|_, module| ctx.env.create_string(module.user_request()))
    }

    #[js_function]
    fn raw_request_getter(ctx: CallContext<'_>) -> napi::Result<JsString<'_>> {
      let this = ctx.this_unchecked::<JsObject>();
      let wrapped_value = unsafe { NormalModule::from_napi_mut_ref(ctx.env.raw(), this.raw())? };
      wrapped_value.module.record_untrackable_read();
      wrapped_value.with_ref(|_, module| ctx.env.create_string(module.raw_request()))
    }

    #[js_function]
    fn resource_resolve_data_getter(ctx: CallContext<'_>) -> napi::Result<Object<'_>> {
      let this = ctx.this_unchecked::<JsObject>();
      let wrapped_value = unsafe { NormalModule::from_napi_mut_ref(ctx.env.raw(), this.raw())? };
      wrapped_value.module.record_untrackable_read();
      crate::module_object_state::get(
        ctx.env,
        Object::from_raw(ctx.env.raw(), unsafe { this.raw() }),
        "resourceResolveData",
      )
    }

    #[js_function]
    fn loaders_getter(ctx: CallContext<'_>) -> napi::Result<Object<'_>> {
      let this = ctx.this_unchecked::<JsObject>();
      let wrapped_value = unsafe { NormalModule::from_napi_mut_ref(ctx.env.raw(), this.raw())? };
      wrapped_value.module.record_untrackable_read();
      crate::module_object_state::get(
        ctx.env,
        Object::from_raw(ctx.env.raw(), unsafe { this.raw() }),
        "loaders",
      )
    }

    #[js_function]
    fn resource_getter(ctx: CallContext<'_>) -> napi::Result<JsString<'_>> {
      let this = ctx.this_unchecked::<JsObject>();
      let wrapped_value = unsafe { NormalModule::from_napi_mut_ref(ctx.env.raw(), this.raw())? };
      wrapped_value.with_ref(|_, module| {
        ctx
          .env
          .create_string(module.resource_resolved_data().resource())
      })
    }

    #[js_function]
    pub fn match_resource_getter(ctx: CallContext<'_>) -> napi::Result<Either<JsString<'_>, ()>> {
      let this = ctx.this_unchecked::<JsObject>();
      let env = ctx.env.raw();
      let wrapped_value = unsafe { NormalModule::from_napi_mut_ref(env, this.raw())? };
      wrapped_value.module.record_untrackable_read();

      wrapped_value.with_ref(|_, module| {
        Ok(match module.match_resource() {
          Some(match_resource) => Either::A(ctx.env.create_string(match_resource.resource())?),
          None => Either::B(()),
        })
      })
    }

    #[js_function(1)]
    pub fn match_resource_setter(ctx: CallContext) -> napi::Result<()> {
      let this = ctx.this_unchecked::<JsObject>();
      let env = ctx.env.raw();
      let wrapped_value = unsafe { NormalModule::from_napi_mut_ref(env, this.raw())? };
      wrapped_value.module.record_untrackable_read();

      let val = ctx.get::<Either<String, ()>>(0)?;
      match val {
        Either::A(val) => {
          let module = wrapped_value.as_mut()?;
          let ResourceParsedData {
            path,
            query,
            fragment,
          } = parse_resource(&val).expect("Should parse resource");
          *module.match_resource_mut() = Some(Box::new(ResourceData::new_with_path(
            val, path, query, fragment,
          )));
        }
        Either::B(_) => {}
      }
      Ok(())
    }

    #[js_function]
    fn error_getter(ctx: CallContext<'_>) -> napi::Result<Either<RspackError, ()>> {
      let this = ctx.this_unchecked::<JsObject>();
      let env = ctx.env.raw();
      let wrapped_value = unsafe { NormalModule::from_napi_mut_ref(env, this.raw())? };
      wrapped_value.module.record_untrackable_read();

      wrapped_value.with_ref(|compilation, module| {
        Ok(match module.first_error() {
          Some(diagnostic) => Either::A(RspackError::try_from_diagnostic(
            compilation,
            diagnostic.as_ref(),
          )?),
          None => Either::B(()),
        })
      })
    }

    define_shared_properties::<Self>(env, object, || {
      Ok(vec![
        napi::Property::new()
          .with_utf8_name("resource")?
          .with_getter(resource_getter),
        napi::Property::new()
          .with_utf8_name("request")?
          .with_getter(request_getter),
        napi::Property::new()
          .with_utf8_name("userRequest")?
          .with_getter(user_request_getter),
        napi::Property::new()
          .with_utf8_name("rawRequest")?
          .with_getter(raw_request_getter),
        napi::Property::new()
          .with_utf8_name("resourceResolveData")?
          .with_getter(resource_resolve_data_getter),
        napi::Property::new()
          .with_utf8_name("loaders")?
          .with_getter(loaders_getter),
        napi::Property::new()
          .with_utf8_name("matchResource")?
          .with_getter(match_resource_getter)
          .with_setter(match_resource_setter),
        napi::Property::new()
          .with_utf8_name("error")?
          .with_getter(error_getter),
      ])
    })
  }

  fn with_ref<R>(
    &mut self,
    f: impl FnOnce(&rspack_core::Compilation, &rspack_core::NormalModule) -> napi::Result<R>,
  ) -> napi::Result<R> {
    self
      .module
      .with_ref(|compilation, module| match module.as_normal_module() {
        Some(normal_module) => f(compilation, normal_module),
        None => Err(napi::Error::new(
          napi::Status::GenericFailure,
          "Module is not a NormalModule",
        )),
      })
  }

  fn as_mut(&mut self) -> napi::Result<&mut rspack_core::NormalModule> {
    let module = self.module.as_mut()?;
    match module.as_normal_module_mut() {
      Some(normal_module) => Ok(normal_module),
      None => Err(napi::Error::new(
        napi::Status::GenericFailure,
        "Module is not a NormalModule",
      )),
    }
  }
}

impl_module_methods!(NormalModule, NormalModule::define_shared_properties);
