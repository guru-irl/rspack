use std::{
  cell::RefCell,
  fmt::Debug,
  marker::PhantomData,
  rc::Rc,
  sync::{Arc, OnceLock},
};

use napi::{
  Env, JsValue, Status, Unknown, ValueType,
  bindgen_prelude::{
    CallbackContext, FromNapiValue, Function, JsValuesTupleIntoVec, Promise, PromiseRaw, TypeName,
    ValidateNapiValue,
  },
  sys::{self, napi_env, napi_value},
  threadsafe_function::{ThreadsafeFunction as RawThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use oneshot::{Receiver, Sender, channel};
use rspack_error::{Error, Result};

use crate::{JsCallback, NapiErrorToRspackErrorExt};

// Chain then/catch on the JS thread so the Rust caller wakes once, with the settled value.
// A thenable can call back synchronously while chaining; hold that value until chaining
// succeeds, so a chaining error still wins, as in napi's `Promise` conversion.
// If JS drops both callbacks unsettled, report `oneshot canceled`, the error napi's `Promise` gives.
struct PromiseSender<R> {
  tx: Option<Sender<Result<napi::Result<R>>>>,
  value: Option<napi::Result<R>>,
  ready: bool,
}

impl<R> PromiseSender<R> {
  fn send(&mut self, value: napi::Result<R>) {
    if self.ready {
      if let Some(tx) = self.tx.take() {
        let _ = tx.send(Ok(value));
      }
    } else if self.value.is_none() {
      self.value = Some(value);
    }
  }
}

impl<R> Drop for PromiseSender<R> {
  fn drop(&mut self) {
    if self.ready
      && let Some(tx) = self.tx.take()
    {
      let _ = tx.send(Ok(Err(napi::Error::new(
        Status::GenericFailure,
        "oneshot canceled",
      ))));
    }
  }
}

fn receive_promise<R: 'static + FromNapiValue>(
  result: napi::Result<Unknown>,
  env: Env,
  tx: Sender<Result<napi::Result<R>>>,
) -> napi::Result<()> {
  let tx = Rc::new(RefCell::new(PromiseSender {
    tx: Some(tx),
    value: None,
    ready: false,
  }));
  let result = match result {
    Err(err) => Err(err.to_rspack_error(&env)),
    Ok(value) => (|| {
      let promise = unsafe { PromiseRaw::<R>::from_napi_value(env.raw(), value.raw()) }?;
      let tx_in_then = tx.clone();
      let tx_in_catch = tx.clone();
      promise
        .then(move |ctx| {
          tx_in_then.borrow_mut().send(Ok(ctx.value));
          Ok(())
        })?
        .catch(move |ctx: CallbackContext<Unknown>| {
          tx_in_catch.borrow_mut().send(Err(ctx.value.into()));
          Ok(())
        })?;
      Ok(())
    })()
    .map_err(|err| pretty_type_error(value, err)),
  };
  let mut tx = tx.borrow_mut();
  match result {
    Ok(()) => {
      if tx.tx.as_ref().expect("should have tsfn sender").is_closed() {
        panic!("failed to send tsfn value");
      }
      tx.ready = true;
      if let Some(value) = tx.value.take() {
        tx.send(value);
      }
    }
    Err(err) => {
      tx.value = None;
      tx.tx
        .take()
        .expect("should have tsfn sender")
        .send(Err(err))
        .unwrap_or_else(|_| panic!("failed to send tsfn value"));
    }
  }
  Ok(())
}

type ErrorResolver = dyn FnOnce(Env);

static ERROR_RESOLVER: OnceLock<JsCallback<Box<ErrorResolver>>> = OnceLock::new();

pub struct ThreadsafeFunction<T: 'static + JsValuesTupleIntoVec, R> {
  inner: Arc<RawThreadsafeFunction<T, Unknown<'static>, T, Status, false, true>>,
  env: napi_env,
  _data: PhantomData<R>,
}

pub struct DynThreadsafeFunction {
  inner: Arc<RawThreadsafeFunction<DynJsArgs, Unknown<'static>, DynJsArgs, Status, false, true>>,
  env: napi_env,
}

struct DynJsArgs(Box<dyn DynJsArgsToVec>);

trait DynJsArgsToVec {
  fn into_vec(self: Box<Self>, env: napi_env) -> napi::Result<Vec<napi_value>>;
}

impl<T: JsValuesTupleIntoVec> DynJsArgsToVec for T {
  fn into_vec(self: Box<Self>, env: napi_env) -> napi::Result<Vec<napi_value>> {
    (*self).into_vec(env)
  }
}

impl JsValuesTupleIntoVec for DynJsArgs {
  fn into_vec(self, env: napi_env) -> napi::Result<Vec<napi_value>> {
    self.0.into_vec(env)
  }
}

impl<T: 'static + JsValuesTupleIntoVec, R> Debug for ThreadsafeFunction<T, R> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ThreadsafeFunction").finish_non_exhaustive()
  }
}

impl<T: 'static + JsValuesTupleIntoVec, R> Clone for ThreadsafeFunction<T, R> {
  fn clone(&self) -> Self {
    Self {
      inner: self.inner.clone(),
      env: self.env,
      _data: self._data,
    }
  }
}

impl Debug for DynThreadsafeFunction {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("DynThreadsafeFunction")
      .finish_non_exhaustive()
  }
}

impl Clone for DynThreadsafeFunction {
  fn clone(&self) -> Self {
    Self {
      inner: self.inner.clone(),
      env: self.env,
    }
  }
}

unsafe impl<T: 'static + JsValuesTupleIntoVec, R> Sync for ThreadsafeFunction<T, R> {}
unsafe impl<T: 'static + JsValuesTupleIntoVec, R> Send for ThreadsafeFunction<T, R> {}
unsafe impl Sync for DynThreadsafeFunction {}
unsafe impl Send for DynThreadsafeFunction {}

impl<T: 'static + JsValuesTupleIntoVec, R> FromNapiValue for ThreadsafeFunction<T, R> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> napi::Result<Self> {
    unsafe { Self::from_napi_value_with_finalize(env, napi_val, || {}) }
  }
}

impl<T: 'static + JsValuesTupleIntoVec, R> ThreadsafeFunction<T, R> {
  /// Runs `finalize` on the owning JS thread when N-API finalizes the TSFN, or
  /// during construction if it fails. The callback may own thread-local data;
  /// it must not retain the TSFN itself and prevent its finalization.
  /// The callback must not panic, since finalization runs through N-API.
  ///
  /// # Safety
  /// `env` and `napi_val` must be valid on the calling JS thread.
  pub unsafe fn from_napi_value_with_finalize(
    env: sys::napi_env,
    napi_val: sys::napi_value,
    finalize: impl FnOnce() + 'static,
  ) -> napi::Result<Self> {
    let finalize = scopeguard::guard(finalize, |finalize| finalize());
    let function = unsafe { Function::<T, Unknown>::from_napi_value(env, napi_val) }?;
    let inner = function
      .build_threadsafe_function::<T>()
      .callee_handled::<false>()
      .weak::<true>()
      .build_callback(move |ctx| {
        // napi-rs owns this closure until its TSFN finalizer drops it on the
        // JS thread. Dropping a Rust TSFN handle on a worker does not drop it.
        let _keep_finalize = &finalize;
        Ok(ctx.value)
      })?;
    let _ = ERROR_RESOLVER
      .get_or_init(|| unsafe { JsCallback::new(env).expect("should initialize error resolver") });
    Ok(Self {
      inner: Arc::new(inner),
      env,
      _data: PhantomData,
    })
  }
}

impl FromNapiValue for DynThreadsafeFunction {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> napi::Result<Self> {
    let inner = unsafe {
      <RawThreadsafeFunction<DynJsArgs, Unknown, DynJsArgs, Status, false, true> as FromNapiValue>::from_napi_value(
        env, napi_val,
      )
    }?;
    let _ = ERROR_RESOLVER
      .get_or_init(|| unsafe { JsCallback::new(env).expect("should initialize error resolver") });
    Ok(Self {
      inner: Arc::new(inner),
      env,
    })
  }
}

impl<T: 'static + JsValuesTupleIntoVec, R> ThreadsafeFunction<T, R> {
  async fn resolve_error(&self, err: napi::Error) -> Error {
    let (tx, rx) = tokio::sync::oneshot::channel::<rspack_error::Error>();
    ERROR_RESOLVER
      .get()
      // SAFETY: Every TSFN constructor initializes the error resolver.
      .expect("should have error resolver initialized")
      .call(Box::new(move |env| {
        let err = err.to_rspack_error(&env);
        tx.send(err).expect("failed to resolve js error");
      }));
    rx.await.expect("failed to resolve js error")
  }

  fn call_with_return<D: 'static + FromNapiValue>(&self, value: T) -> Receiver<Result<D>> {
    let (tx, rx) = channel::<Result<D>>();
    self
      .inner
      .call_with_return_value(value, ThreadsafeFunctionCallMode::NonBlocking, {
        move |r: napi::Result<Unknown>, env| {
          let r = match r {
            Err(err) => Err(err.to_rspack_error(&env)),
            Ok(o) => {
              let raw_env = env.raw();
              let return_value = o.raw();
              unsafe { D::from_napi_value(raw_env, return_value) }
                .map_err(|e| pretty_type_error(o, e))
            }
          };
          tx.send(r)
            .unwrap_or_else(|_| panic!("failed to send tsfn value"));
          Ok(())
        }
      });
    rx
  }

  async fn call_async<D: 'static + FromNapiValue>(&self, value: T) -> Result<D> {
    let rx = self.call_with_return(value);
    rx.await.expect("failed to receive tsfn value")
  }
}

impl DynThreadsafeFunction {
  async fn resolve_error(&self, err: napi::Error) -> Error {
    let (tx, rx) = tokio::sync::oneshot::channel::<rspack_error::Error>();
    ERROR_RESOLVER
      .get()
      // SAFETY: The error resolver is initialized in `FromNapiValue::from_napi_value` and it's the only way to create a tsfn.
      .expect("should have error resolver initialized")
      .call(Box::new(move |env| {
        let err = err.to_rspack_error(&env);
        tx.send(err).expect("failed to resolve js error");
      }));
    rx.await.expect("failed to resolve js error")
  }

  fn call_with_return<T, D>(&self, value: T) -> Receiver<Result<D>>
  where
    T: 'static + JsValuesTupleIntoVec,
    D: 'static + FromNapiValue,
  {
    let (tx, rx) = channel::<Result<D>>();
    self.inner.call_with_return_value(
      DynJsArgs(Box::new(value)),
      ThreadsafeFunctionCallMode::NonBlocking,
      {
        move |r: napi::Result<Unknown>, env| {
          let r = match r {
            Err(err) => Err(err.to_rspack_error(&env)),
            Ok(o) => {
              let raw_env = env.raw();
              let return_value = o.raw();
              unsafe { D::from_napi_value(raw_env, return_value) }
                .map_err(|e| pretty_type_error(o, e))
            }
          };
          tx.send(r)
            .unwrap_or_else(|_| panic!("failed to send tsfn value"));
          Ok(())
        }
      },
    );
    rx
  }

  async fn call_async<T, D>(&self, value: T) -> Result<D>
  where
    T: 'static + JsValuesTupleIntoVec,
    D: 'static + FromNapiValue,
  {
    let rx = self.call_with_return(value);
    rx.await.expect("failed to receive tsfn value")
  }

  /// Call the JS function.
  pub async fn call_with_sync<T, R>(&self, value: T) -> Result<R>
  where
    T: 'static + JsValuesTupleIntoVec,
    R: 'static + FromNapiValue,
  {
    self.call_async::<T, R>(value).await
  }

  /// Call the JS function.
  /// If `Promise<T>` is returned, it will be awaited and its value `T` will be returned.
  /// Otherwise, an [napi::Error] is returned.
  pub async fn call_with_promise<T, R>(&self, value: T) -> Result<R>
  where
    T: 'static + JsValuesTupleIntoVec,
    R: 'static + FromNapiValue,
  {
    let (tx, rx) = channel();
    self.inner.call_with_return_value(
      DynJsArgs(Box::new(value)),
      ThreadsafeFunctionCallMode::NonBlocking,
      move |result, env| receive_promise(result, env, tx),
    );
    match rx.await.expect("failed to receive tsfn value")? {
      Ok(value) => Ok(value),
      Err(err) => Err(self.resolve_error(err).await),
    }
  }
}

impl<T: 'static + JsValuesTupleIntoVec, R: 'static + FromNapiValue> ThreadsafeFunction<T, R> {
  /// Call the JS function.
  pub async fn call_with_sync(&self, value: T) -> Result<R> {
    self.call_async::<R>(value).await
  }
}

impl<T: 'static + JsValuesTupleIntoVec, R: 'static + FromNapiValue>
  ThreadsafeFunction<T, Promise<R>>
{
  /// Call the JS function.
  /// If `Promise<T>` is returned, it will be awaited and its value `T` will be returned.
  /// Otherwise, an [napi::Error] is returned.
  pub async fn call_with_promise(&self, value: T) -> Result<R> {
    let (tx, rx) = channel();
    self.inner.call_with_return_value(
      value,
      ThreadsafeFunctionCallMode::NonBlocking,
      move |result, env| receive_promise(result, env, tx),
    );
    match rx.await.expect("failed to receive tsfn value")? {
      Ok(value) => Ok(value),
      Err(err) => Err(self.resolve_error(err).await),
    }
  }
}

impl<T: 'static + JsValuesTupleIntoVec + JsValuesTupleIntoVec, R> ValidateNapiValue
  for ThreadsafeFunction<T, R>
{
}

impl ValidateNapiValue for DynThreadsafeFunction {}

impl<T: 'static + JsValuesTupleIntoVec, R> TypeName for ThreadsafeFunction<T, R> {
  fn type_name() -> &'static str {
    "ThreadsafeFunction"
  }

  fn value_type() -> napi::ValueType {
    ValueType::Function
  }
}

impl TypeName for DynThreadsafeFunction {
  fn type_name() -> &'static str {
    "ThreadsafeFunction"
  }

  fn value_type() -> napi::ValueType {
    ValueType::Function
  }
}

fn pretty_type_error(return_value: Unknown, error: napi::Error) -> rspack_error::Error {
  let expected_type = match error.status {
    Status::ObjectExpected => "object",
    Status::StringExpected => "string",
    Status::FunctionExpected => "function",
    Status::NumberExpected => "number",
    Status::BooleanExpected => "boolean",
    Status::ArrayExpected => "Array",
    Status::BigintExpected => "bigint",
    Status::DateExpected => "Date",
    Status::ArrayBufferExpected => "ArrayBuffer",
    _ => return rspack_error::error!("{}", error),
  };
  let reason = match return_value.get_type() {
    Ok(return_value_type) => {
      let return_value_type_str = match return_value_type {
        ValueType::Undefined => "undefined",
        ValueType::Null => "null",
        ValueType::Boolean => "boolean",
        ValueType::Number => "number",
        ValueType::String => "string",
        ValueType::Symbol => "symbol",
        ValueType::Object => "object",
        ValueType::Function => "function",
        ValueType::External => "external",
        ValueType::BigInt => "bigint",
        _ => "unknown",
      };
      format!(
        "TypeError: Expected return a '{expected_type}' value, but received `{return_value_type_str}`"
      )
    }
    Err(_) => format!("TypeError: Expected return a '{expected_type}' value"),
  };
  rspack_error::error!(reason)
}

#[cfg(allocative)]
impl<T: 'static + JsValuesTupleIntoVec, R> allocative::Allocative for ThreadsafeFunction<T, R> {
  fn visit<'a, 'b: 'a>(&self, visitor: &'a mut allocative::Visitor<'b>) {
    let mut visitor = visitor.enter_self(self);
    visitor.visit_field(allocative::Key::new("inner"), &self.inner);
    // env is borrowed from Node; PhantomData owns no T/R values.
    visitor.exit();
  }
}
#[cfg(allocative)]
impl allocative::Allocative for DynThreadsafeFunction {
  fn visit<'a, 'b: 'a>(&self, visitor: &'a mut allocative::Visitor<'b>) {
    let mut visitor = visitor.enter_self(self);
    visitor.visit_field(allocative::Key::new("inner"), &self.inner);
    visitor.exit();
  }
}
