use std::{
  cell::{Cell, RefCell},
  collections::HashMap,
  rc::Rc,
};

use napi::{
  Env, Status,
  bindgen_prelude::{
    CallbackContext, Either3, Function, JsObjectValue, JsValuesTupleIntoVec, Unknown,
  },
  threadsafe_function::ThreadsafeFunctionCallMode,
};
use rspack_core::{AdditionalData, LoaderContext, NormalModuleLoaderStartYielding, RunnerContext};
use rspack_error::{Result, ToStringResultToRspackResultExt};
use rspack_hook::plugin_hook;
use rspack_loader_runner::State as LoaderState;

use super::{JsLoaderContext, JsLoaderRspackPlugin, JsLoaderRspackPluginInner, JsLoaderRunner};

type LoaderCompletion = (
  futures::channel::oneshot::Sender<napi::Result<JsLoaderContext>>,
  napi::Result<JsLoaderContext>,
);

// This guard also delivers if Tokio rejects or cancels a task during shutdown.
#[derive(Default)]
struct CompletionBatch(Vec<LoaderCompletion>);

impl CompletionBatch {
  fn deliver(&mut self) {
    for (sender, result) in self.0.drain(..) {
      let _ = sender.send(result);
    }
  }
}

impl Drop for CompletionBatch {
  fn drop(&mut self) {
    self.deliver();
  }
}

struct CompletionQueue {
  batch: RefCell<CompletionBatch>,
  scheduled: Cell<bool>,
  closing: Cell<bool>,
  runtime: tokio::runtime::Handle,
}

thread_local! {
  static COMPLETION_QUEUES: RefCell<HashMap<usize, Rc<CompletionQueue>>> = RefCell::default();
}

fn completion_queue(
  env: &Env,
  runtime: &tokio::runtime::Handle,
) -> napi::Result<Rc<CompletionQueue>> {
  let key = env.raw() as usize;
  if let Some(queue) = COMPLETION_QUEUES.with_borrow(|queues| queues.get(&key).cloned()) {
    return Ok(queue);
  }
  let queue = Rc::new(CompletionQueue {
    batch: RefCell::default(),
    scheduled: Cell::new(false),
    closing: Cell::new(false),
    runtime: runtime.clone(),
  });
  env.add_env_cleanup_hook(key, |key| {
    let queue = COMPLETION_QUEUES.with_borrow_mut(|queues| queues.remove(&key));
    if let Some(queue) = queue {
      queue.closing.set(true);
      queue.scheduled.set(false);
      // No JavaScript or runtime access is needed at environment teardown.
      queue.batch.borrow_mut().deliver();
    }
  })?;
  COMPLETION_QUEUES.with_borrow_mut(|queues| queues.insert(key, Rc::clone(&queue)));
  Ok(queue)
}

fn flush_completions(queue: &CompletionQueue) {
  let mut batch = std::mem::take(&mut *queue.batch.borrow_mut());
  if batch.0.is_empty() {
    return;
  }
  // Handle::spawn uses the runtime awaiting the loader receivers, not a new pool.
  // The guard retains direct delivery if spawning unwinds or the task is dropped.
  let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    std::mem::drop(queue.runtime.spawn(async move { batch.deliver() }));
  }));
}

fn enqueue_completion(
  env: &Env,
  runtime: Option<&tokio::runtime::Handle>,
  sender: futures::channel::oneshot::Sender<napi::Result<JsLoaderContext>>,
  result: napi::Result<JsLoaderContext>,
) {
  let queue = runtime.and_then(|runtime| completion_queue(env, runtime).ok());
  let Some(queue) = queue.filter(|queue| !queue.closing.get()) else {
    let _ = sender.send(result);
    return;
  };
  queue.batch.borrow_mut().0.push((sender, result));
  if queue.batch.borrow().0.len() >= 64 {
    flush_completions(&queue);
  }
  if queue.scheduled.replace(true) {
    return;
  }
  let schedule = || -> napi::Result<()> {
    let queue = Rc::clone(&queue);
    let callback =
      env.create_function_from_closure::<(), (), _>("flushLoaderCompletions", move |_| {
        queue.scheduled.set(false);
        flush_completions(&queue);
        Ok(())
      })?;
    let immediate: Function<'_, Function<'_, (), ()>, Unknown<'_>> =
      env.get_global()?.get_named_property("setImmediate")?;
    immediate.call(callback)?;
    Ok(())
  };
  if schedule().is_err() {
    queue.scheduled.set(false);
    queue.batch.borrow_mut().deliver();
  }
}

async fn call_loader_runner(
  runner: &JsLoaderRunner,
  context: JsLoaderContext,
) -> napi::Result<JsLoaderContext> {
  let runtime = tokio::runtime::Handle::try_current().ok();
  let (tx, rx) = futures::channel::oneshot::channel();
  let status = runner.call_with_return_value(
    context,
    ThreadsafeFunctionCallMode::NonBlocking,
    move |result, _| {
      // Match napi-rs Promise conversion, but deliver only the settled value.
      result.and_then(|promise| {
        let tx = Rc::new(Cell::new(Some(tx)));
        let tx_in_catch = tx.clone();
        let runtime_in_catch = runtime.clone();
        promise
          .then(move |ctx| {
            if let Some(tx) = tx.replace(None) {
              enqueue_completion(&ctx.env, runtime.as_ref(), tx, Ok(ctx.value));
            }
            Ok(())
          })?
          .catch(move |ctx: CallbackContext<Unknown>| {
            if let Some(tx) = tx_in_catch.replace(None) {
              enqueue_completion(
                &ctx.env,
                runtime_in_catch.as_ref(),
                tx,
                Err(ctx.value.into()),
              );
            }
            Ok(())
          })?;
        Ok(())
      })
    },
  );
  if status != Status::Ok {
    return Err(if status == Status::Closing && runner.aborted() {
      napi::Error::from_status(Status::Closing)
    } else {
      napi::Error::new(status, "")
    });
  }
  rx.await
    .map_err(|err| napi::Error::new(Status::GenericFailure, format!("{err}")))?
}

impl JsLoaderRspackPlugin {
  async fn update_loaders_without_pitch(&self, list: Vec<String>) {
    let mut loaders_without_pitch = self.loaders_without_pitch.write().await;
    for path in list {
      loaders_without_pitch.insert(path);
    }
  }
}

#[plugin_hook(NormalModuleLoaderStartYielding for JsLoaderRspackPlugin,tracing=false)]
pub(crate) async fn loader_yield(
  &self,
  loader_context: &mut LoaderContext<RunnerContext>,
) -> Result<()> {
  // Keep pitch capability discovery on the JS side of the runtime boundary.
  // A loader known not to have a pitch function does not need a JS callback.
  if loader_context.state() == LoaderState::Pitching
    && self
      .loaders_without_pitch
      .read()
      .await
      .contains(loader_context.current_loader().path().as_str())
  {
    loader_context.current_loader().set_pitch_executed();
    loader_context.loader_index += 1;
    return Ok(());
  }

  let runner = self.runner.lock().expect("should get lock").clone();
  let runner = runner
    .get_or_try_init(|| async {
      #[allow(clippy::unwrap_used)]
      let compiler_id = self.compiler_id.get().unwrap();
      self.runner_getter.call(compiler_id).await
    })
    .await
    .to_rspack_result()?;

  let new_cx = call_loader_runner(runner, loader_context.try_into()?)
    .await
    .to_rspack_result()?;

  if loader_context.state() == LoaderState::Pitching {
    let list = collect_loaders_without_pitch(loader_context, &new_cx);
    if !list.is_empty() {
      self.update_loaders_without_pitch(list).await;
    }
  }

  merge_loader_context(loader_context, new_cx)?;

  Ok(())
}

pub(crate) fn merge_loader_context(
  to: &mut LoaderContext<RunnerContext>,
  mut from: JsLoaderContext,
) -> Result<()> {
  to.cacheable = from.cacheable;
  to.replace_dependencies(from.dependencies.into());

  if let Some(error) = from.error {
    if let Some(diagnostic) = error.rust_diagnostic.as_ref() {
      return Err(diagnostic.error.clone());
    }
    return Err(error.with_parent_error_name("ModuleBuildError").into());
  }

  let content = match from.content {
    Either3::A(content) => Some(rspack_core::Content::String(content)),
    Either3::B(content) => Some(rspack_core::Content::Buffer(content.into())),
    Either3::C(_) => None,
  };
  let source_map = from
    .source_map
    .map(|buffer| rspack_core::rspack_sources::SourceMap::from_bytes(buffer.into()))
    .transpose()
    .to_rspack_result()?;
  let additional_data = from.additional_data.take().map(|data| {
    let mut additional = AdditionalData::default();
    additional.insert(data);
    additional
  });
  to.__finish_with((content, source_map, additional_data));

  // update loader status
  to.loader_items = to
    .loader_items
    .drain(..)
    .zip(from.loader_items.drain(..))
    .map(|(mut to, from)| {
      if from.normal_executed {
        to.set_normal_executed()
      }
      if from.pitch_executed {
        to.set_pitch_executed()
      }
      to.set_data(from.data);
      // JS loader should always be considered as finished
      to.set_finish_called();
      to
    })
    .collect();
  to.loader_index = from.loader_index;
  to.parse_meta.extend(
    from
      .parse_meta
      .into_iter()
      .map(|(k, v)| (k, Box::new(v) as _)),
  );

  Ok(())
}

fn collect_loaders_without_pitch(
  ctx: &LoaderContext<RunnerContext>,
  js_ctx: &JsLoaderContext,
) -> Vec<String> {
  let mut list = Vec::new();
  for (js_loader_item, loader_item) in js_ctx.loader_items.iter().zip(ctx.loader_items.iter()) {
    if js_loader_item.no_pitch {
      list.push(loader_item.path().to_string());
    }
  }
  list
}
