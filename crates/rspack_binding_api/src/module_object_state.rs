use std::cell::RefCell;

use napi::{
  Env,
  bindgen_prelude::{
    FnArgs, FromNapiValue, Function, JsObjectValue, Object, ObjectRef, ToNapiValue,
  },
};
use rustc_hash::FxHashMap;

thread_local! {
  static STORES: RefCell<FxHashMap<napi::sys::napi_env, ObjectRef<false>>> = RefCell::default();
}

pub(crate) fn store<'a>(env: &'a Env) -> napi::Result<Object<'a>> {
  if let Some(value) =
    STORES.with_borrow(|stores| stores.get(&env.raw()).map(|r| r.get_value(env)).transpose())?
  {
    return Ok(value);
  }
  let value: Object = env.run_script(r#"(() => {
    const states = new WeakMap();
    const templates = new WeakMap();
    const ownKeys = Reflect.ownKeys;
    const descriptor = Object.getOwnPropertyDescriptor;
    const prototype = Object.getPrototypeOf;
    const extensible = Object.isExtensible;
    const same = (a, b) => a && b && a.enumerable === b.enumerable &&
      a.configurable === b.configurable && a.writable === b.writable &&
      a.get === b.get && a.set === b.set && Object.is(a.value, b.value);
    const behaviors = new Map();
    const capture = object => {
      if (!object || (typeof object !== 'object' && typeof object !== 'function') || behaviors.has(object)) return;
      const keys = ownKeys(object);
      const descriptors = new Map(keys.map(key => [key, descriptor(object, key)]));
      const proto = prototype(object);
      behaviors.set(object, { keys, descriptors, proto, extensible: extensible(object) });
      capture(proto);
      for (const d of descriptors.values()) { capture(d.value); capture(d.get); capture(d.set); }
    };
    const changed = () => {
      for (const [object, before] of behaviors) {
        const keys = ownKeys(object);
        if (extensible(object) !== before.extensible || prototype(object) !== before.proto || keys.length !== before.keys.length || keys.some((key, index) => key !== before.keys[index])) return true;
        for (const [key, expected] of before.descriptors) if (!same(descriptor(object, key), expected)) return true;
      }
      return false;
    };
    const state = object => {
      let result = states.get(object);
      if (!result) { result = Object.create(null); states.set(object, result); }
      return result;
    };
    return {
      get(object, key) { return state(object)[key]; },
      set(object, key, value) { state(object)[key] = value; },
      seed(object) {
        const proto = prototype(object);
        let template = templates.get(proto);
        if (!template) {
          const keys = ownKeys(object);
          template = { keys, mutable: keys.filter(key => {
            const d = descriptor(object, key);
            return d.configurable || d.writable;
          }) };
          templates.set(proto, template);
        }
        for (const key of template.keys) { const d = descriptor(object, key); capture(d.get); capture(d.set); if (typeof d.value === 'function') capture(d.value); }
        state(object).shape = {
          proto, extensible: extensible(object), keys: template.keys, mutable: new Map(template.mutable.map(key => [key, descriptor(object, key)])),
        };
      },
      allow(object, key) {
        const shape = state(object).shape;
        if (shape) {
          if (!shape.keys.includes(key)) shape.keys = [...shape.keys, key];
          const d = descriptor(object, key);
          shape.mutable.set(key, d);
          capture(d.get); capture(d.set);
        }
      },
      check(objects) {
        let custom = changed() ? 1 : 0;
        for (const object of objects) {
          const shape = state(object).shape;
          const keys = ownKeys(object);
          if (!shape || extensible(object) !== shape.extensible || prototype(object) !== shape.proto || keys.length !== shape.keys.length ||
              keys.some((key, index) => key !== shape.keys[index]) ||
              [...shape.mutable].some(([key, expected]) => !same(descriptor(object, key), expected))) custom++;
        }
        return custom;
      },
    };
  })()"#)?;
  let reference = value.create_ref()?;
  let raw_env = env.raw();
  if let Err(error) = env.add_env_cleanup_hook(raw_env, |raw_env| {
    if let Some(reference) = STORES.with_borrow_mut(|stores| stores.remove(&raw_env)) {
      let _ = reference.unref(&Env::from(raw_env));
    }
  }) {
    reference.unref(env)?;
    return Err(error);
  }
  STORES.with_borrow_mut(|stores| stores.insert(raw_env, reference));
  Ok(value)
}

pub(crate) fn get<'a, T: FromNapiValue>(
  env: &'a Env,
  object: Object<'a>,
  key: &str,
) -> napi::Result<T> {
  let function: Function<FnArgs<(Object, &str)>, T> = store(env)?.get_named_property("get")?;
  function.call((object, key).into())
}

pub(crate) fn set<'a, T: ToNapiValue>(
  env: &'a Env,
  object: Object<'a>,
  key: &str,
  value: T,
) -> napi::Result<()> {
  let function: Function<FnArgs<(Object, &str, T)>, ()> = store(env)?.get_named_property("set")?;
  function.call((object, key, value).into())
}

pub(crate) fn seed(env: &Env, object: Object<'_>) -> napi::Result<()> {
  let function: Function<Object, ()> = store(env)?.get_named_property("seed")?;
  function.call(object)
}

pub(crate) fn allow<'a, T: ToNapiValue>(
  env: &'a Env,
  object: Object<'a>,
  key: T,
) -> napi::Result<()> {
  let function: Function<FnArgs<(Object, T)>, ()> = store(env)?.get_named_property("allow")?;
  function.call((object, key).into())
}

#[napi]
pub fn get_module_object_state_store(env: &Env) -> napi::Result<Object<'_>> {
  store(env)
}
