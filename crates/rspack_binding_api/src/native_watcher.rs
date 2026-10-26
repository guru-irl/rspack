use std::{
  boxed::Box,
  collections::VecDeque,
  path::{Path, PathBuf},
  sync::{Arc, Mutex},
  time::{Duration, SystemTime, UNIX_EPOCH},
};

use napi::bindgen_prelude::*;
use napi_derive::*;
use rspack_napi::threadsafe_function::ThreadsafeFunction;
use rspack_paths::InternedPath;
use rspack_regex::RspackRegex;
use rspack_watcher::{
  FsEventKind, FsWatcher, FsWatcherIgnored, FsWatcherOptions, IgnoredFn, TimeInfoEntries,
  TimeInfoEntry,
};
use rustc_hash::FxHashSet;

type JsWatcherIgnored = Either4<String, Vec<String>, RspackRegex, ThreadsafeFunction<String, bool>>;

fn to_fs_watcher_ignored(ignored: Option<JsWatcherIgnored>) -> FsWatcherIgnored {
  if let Some(ignored) = ignored {
    match ignored {
      Either4::A(path) => FsWatcherIgnored::Path(path),
      Either4::B(paths) => FsWatcherIgnored::Paths(paths),
      Either4::C(regex) => FsWatcherIgnored::Regex(regex),
      Either4::D(func) => FsWatcherIgnored::Function(to_ignored_fn(func)),
    }
  } else {
    FsWatcherIgnored::None
  }
}

fn to_ignored_fn(func: ThreadsafeFunction<String, bool>) -> IgnoredFn {
  Arc::new(move |path: String| {
    let func = func.clone();
    Box::pin(async move {
      match func.call_with_sync(path.clone()).await {
        Ok(ignored) => ignored,
        Err(e) => {
          tracing::error!("failed to call the `ignored` function with `{path}`: {e}");
          false
        }
      }
    })
  })
}

#[napi(object, object_to_js = false)]
pub struct NativeWatcherOptions {
  pub follow_symlinks: Option<bool>,

  pub poll_interval: Option<u32>,

  pub aggregate_timeout: Option<u32>,

  #[napi(ts_type = "string | string[] | RegExp | ((entry: string) => boolean)")]
  /// The ignored paths for the watcher.
  /// It can be a single path, an array of paths, a regular expression, or a
  /// predicate returning `true` for entries to ignore.
  pub ignored: Option<JsWatcherIgnored>,
}

#[napi]
pub struct NativeWatchResult {
  pub changed_files: Vec<String>,
  pub removed_files: Vec<String>,
}

/// One row of watchpack's `TimeInfoEntries`, flattened for napi: a file's
/// `Entry` carries all three times, a directory's `OnlySafeTimeEntry` only
/// `safe_time`, and an `ExistenceOnlyTimeEntry` sets `existence_only`.
#[napi(object)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTimeInfoEntry {
  pub path: String,
  pub existence_only: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub safe_time: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub timestamp: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub accuracy: Option<f64>,
}

#[napi(object)]
#[derive(serde::Serialize)]
pub struct NativeTimeInfoTable {
  pub entries: Vec<NativeTimeInfoEntry>,
  pub missing: Vec<String>,
}

/// Owns the timestamp snapshot so either table can be converted after the watcher closes.
#[napi]
pub struct NativeTimeInfoEntries {
  file_timestamps: TimeInfoEntries,
  directory_timestamps: TimeInfoEntries,
}

#[napi]
impl NativeTimeInfoEntries {
  #[napi(getter, ts_return_type = "NativeTimeInfoTable")]
  pub fn file_timestamps<'env>(
    &mut self,
    env: &'env Env,
    this: This<'env>,
  ) -> napi::Result<Object<'env>> {
    cache_time_info_table(
      env,
      this,
      "fileTimestamps",
      std::mem::take(&mut self.file_timestamps),
    )
  }

  #[napi(getter, ts_return_type = "NativeTimeInfoTable")]
  pub fn directory_timestamps<'env>(
    &mut self,
    env: &'env Env,
    this: This<'env>,
  ) -> napi::Result<Object<'env>> {
    cache_time_info_table(
      env,
      this,
      "directoryTimestamps",
      std::mem::take(&mut self.directory_timestamps),
    )
  }
}

fn cache_time_info_table<'env>(
  env: &'env Env,
  mut this: This<'env>,
  name: &str,
  entries: TimeInfoEntries,
) -> napi::Result<Object<'env>> {
  let json = serde_json::to_string(&to_native_time_info_table(entries))
    .map_err(|error| napi::Error::from_reason(error.to_string()))?;
  let json_object: Object = env.get_global()?.get_named_property("JSON")?;
  let parse: Function<String, Object<'env>> = json_object.get_named_property("parse")?;
  let value = parse.call(json)?;
  this.define_properties(&[Property::new()
    .with_utf8_name(name)?
    .with_value(&value)
    .with_property_attributes(PropertyAttributes::Enumerable)])?;
  Ok(value)
}

fn to_native_time_info_table(entries: TimeInfoEntries) -> NativeTimeInfoTable {
  let missing_rows = {
    let mut missing_paths = FxHashSet::default();
    for (path, entry) in &entries {
      if matches!(entry, TimeInfoEntry::Null) {
        missing_paths.insert(path.as_str());
      } else {
        missing_paths.remove(path.as_str());
      }
    }
    entries
      .iter()
      .map(|(path, entry)| {
        matches!(entry, TimeInfoEntry::Null) && missing_paths.contains(path.as_str())
      })
      .collect::<Vec<_>>()
  };
  let mut table = NativeTimeInfoTable {
    entries: Vec::new(),
    missing: Vec::new(),
  };
  for ((path, entry), missing) in entries.into_iter().zip(missing_rows) {
    if matches!(entry, TimeInfoEntry::Null) {
      if missing {
        table.missing.push(path);
      }
      continue;
    }
    let mut row = NativeTimeInfoEntry {
      path,
      existence_only: false,
      safe_time: None,
      timestamp: None,
      accuracy: None,
    };
    match entry {
      TimeInfoEntry::Entry {
        safe_time,
        timestamp,
        accuracy,
      } => {
        row.safe_time = Some(safe_time as f64);
        row.timestamp = Some(timestamp as f64);
        row.accuracy = Some(accuracy as f64);
      }
      TimeInfoEntry::OnlySafeTimeEntry { safe_time } => {
        row.safe_time = Some(safe_time as f64);
      }
      TimeInfoEntry::ExistenceOnlyTimeEntry => row.existence_only = true,
      TimeInfoEntry::Null => unreachable!(),
    }
    table.entries.push(row);
  }
  table
}

/// A single, undelayed file system event delivered to the `callbackUndelayed`
/// callback. Passed as one object so napi-rs delivers it as a single JS
/// argument unambiguously (a tuple would arrive as an array).
#[napi(object)]
pub struct NativeWatchUndelayedEvent {
  pub kind: String,
  pub path: String,
}

#[napi]
pub struct NativeWatcher {
  watcher: FsWatcher,
  closed: bool,
}

fn timestamp_to_system_time(millis: u64) -> SystemTime {
  UNIX_EPOCH + Duration::from_millis(millis)
}

#[napi]
impl NativeWatcher {
  #[napi(constructor)]
  pub fn new(options: NativeWatcherOptions) -> Self {
    let watcher = FsWatcher::new(
      FsWatcherOptions {
        follow_symlinks: options.follow_symlinks.unwrap_or(false),
        poll_interval: options.poll_interval,
        aggregate_timeout: options.aggregate_timeout,
      },
      to_fs_watcher_ignored(options.ignored),
    );

    Self {
      watcher,
      closed: false,
    }
  }

  #[napi]
  pub fn watch(
    &mut self,
    files: (Vec<String>, Vec<String>),
    directories: (Vec<String>, Vec<String>),
    missing: (Vec<String>, Vec<String>),
    start_time: BigInt,
    #[napi(ts_arg_type = "(err: Error | null, result: NativeWatchResult) => void")]
    callback: Function<'static>,
    #[napi(ts_arg_type = "(event: NativeWatchUndelayedEvent) => void")]
    callback_undelayed: Function<'static>,
  ) -> napi::Result<()> {
    if self.closed {
      return Err(napi::Error::from_reason(
        "The native watcher has been closed, cannot watch again.",
      ));
    }

    let js_event_handler = JsEventHandler::new(callback)?;
    let js_event_handler_undelayed = JsEventHandlerUndelayed::new(callback_undelayed)?;

    let start_time = start_time.get_u64().1;

    // `FsWatcher::watch` has already enqueued the request by the time it
    // returns; the future only signals "applied", so dropping it cancels
    // nothing.
    #[allow(clippy::let_underscore_future)]
    let _ = self.watcher.watch(
      to_tuple_path_iterator(files),
      to_tuple_path_iterator(directories),
      to_tuple_path_iterator(missing),
      timestamp_to_system_time(start_time),
      Box::new(js_event_handler),
      Box::new(js_event_handler_undelayed),
    );

    Ok(())
  }

  #[napi(ts_type = "(kind: 'change' | 'remove' | 'create', path: string): void")]
  pub fn trigger_event(&self, kind: String, path: String) {
    if let Some(kind) = match kind.as_str() {
      "change" => Some(FsEventKind::Change),
      "remove" => Some(FsEventKind::Remove),
      "create" => Some(FsEventKind::Create),
      _ => None,
    } {
      self
        .watcher
        .trigger_event(&InternedPath::from(AsRef::<Path>::as_ref(&path)), kind);
    }
  }

  #[napi(ts_return_type = "Promise<void>")]
  pub fn close<'env>(&mut self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
    self.closed = true;

    // Call outside the async block: the synchronous enqueue keeps close
    // ordered behind preceding `watch` calls.
    let closing = self.watcher.close();

    rspack_napi::runtime::promise_from_future(env, async move {
      closing
        .await
        .map_err(|e| napi::Error::from_reason(e.to_string()))
    })
  }

  /// watchpack's `aggregatedChanges` / `aggregatedRemovals`: the events that
  /// arrived since the last aggregated batch (while paused), read without
  /// draining them.
  #[napi]
  pub fn peek_aggregated(&self) -> NativeWatchResult {
    let (changed_files, removed_files) = self.watcher.peek_aggregated();
    NativeWatchResult {
      changed_files: changed_files.into_iter().collect(),
      removed_files: removed_files.into_iter().collect(),
    }
  }

  /// watchpack's `getAggregated`: the same events, drained, for the build
  /// that folds them in.
  #[napi]
  pub fn get_aggregated(&self) -> NativeWatchResult {
    let (changed_files, removed_files) = self.watcher.take_aggregated();
    NativeWatchResult {
      changed_files: changed_files.into_iter().collect(),
      removed_files: removed_files.into_iter().collect(),
    }
  }

  /// watchpack's `collectTimeInfoEntries`, over every registered path.
  #[napi]
  pub fn collect_time_info_entries(&self) -> NativeTimeInfoEntries {
    let (file_timestamps, directory_timestamps) = self.watcher.collect_time_info_entries();
    NativeTimeInfoEntries {
      file_timestamps,
      directory_timestamps,
    }
  }

  #[napi]
  pub fn pause(&self) -> napi::Result<()> {
    self
      .watcher
      .pause()
      .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    Ok(())
  }
}

fn to_tuple_path_iterator(
  tuple: (Vec<String>, Vec<String>),
) -> (
  impl Iterator<Item = InternedPath>,
  impl Iterator<Item = InternedPath>,
) {
  (
    tuple
      .0
      .into_iter()
      .map(|s| InternedPath::from(PathBuf::from(s))),
    tuple
      .1
      .into_iter()
      .map(|s| InternedPath::from(PathBuf::from(s))),
  )
}

#[derive(Default)]
struct PendingEvents {
  changed_files: FxHashSet<String>,
  removed_files: FxHashSet<String>,
  errors: VecDeque<napi::Error>,
  in_flight: bool,
  closed: bool,
}

#[derive(Clone)]
struct JsEventHandler {
  inner: Arc<
    napi::threadsafe_function::ThreadsafeFunction<
      JsEventHandler,
      napi::Unknown<'static>,
      NativeWatchResult,
      Status,
      true,
      true,
      1,
    >,
  >,
  pending: Arc<Mutex<PendingEvents>>,
}

impl JsEventHandler {
  fn new(callback: Function<'static>) -> napi::Result<Self> {
    let callback = callback
      .build_threadsafe_function::<JsEventHandler>()
      .callee_handled::<true>()
      .max_queue_size::<1>()
      .weak::<true>()
      .build_callback(
        |ctx: napi::threadsafe_function::ThreadSafeCallContext<JsEventHandler>| {
          let handler = ctx.value;
          let mut pending = handler.pending.lock().expect("pending events poisoned");
          // Take the latest sets on the JS thread, not when the call is queued.
          pending.in_flight = false;
          if let Some(error) = pending.errors.pop_front() {
            // Errors use separate callbacks ahead of earlier changes; current callers never mix them.
            handler.schedule(&mut pending);
            return Err(error);
          }
          let changed_files = std::mem::take(&mut pending.changed_files);
          let removed_files = std::mem::take(&mut pending.removed_files);
          drop(pending);
          Ok(NativeWatchResult {
            changed_files: changed_files.into_iter().collect(),
            removed_files: removed_files.into_iter().collect(),
          })
        },
      )?;

    Ok(Self {
      inner: Arc::new(callback),
      pending: Default::default(),
    })
  }

  fn schedule(&self, pending: &mut PendingEvents) {
    if pending.closed
      || pending.in_flight
      || (pending.changed_files.is_empty()
        && pending.removed_files.is_empty()
        && pending.errors.is_empty())
    {
      return;
    }
    pending.in_flight = true;
    // The queued value keeps this generation's state and callback alive.
    let status = self.inner.call(
      Ok(self.clone()),
      napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
    );
    // The JS thread clears in_flight only after Node has popped the previous call.
    debug_assert_ne!(status, Status::QueueFull);
    if status != Status::Ok {
      pending.in_flight = false;
      if status == Status::Closing {
        // Failed calls can leak their queued value, so never retry a closed callback.
        *pending = PendingEvents {
          closed: true,
          ..Default::default()
        };
      }
      tracing::debug!("Native watcher delivery failed: {status:?}");
    }
  }
}

impl rspack_watcher::EventAggregateHandler for JsEventHandler {
  fn on_event_handle(
    &self,
    changed_files: rspack_util::fx_hash::FxHashSet<String>,
    deleted_files: rspack_util::fx_hash::FxHashSet<String>,
  ) {
    let mut pending = self.pending.lock().expect("pending events poisoned");
    if pending.closed {
      return;
    }
    for path in changed_files {
      pending.removed_files.remove(&path);
      pending.changed_files.insert(path);
    }
    for path in deleted_files {
      pending.changed_files.remove(&path);
      pending.removed_files.insert(path);
    }
    self.schedule(&mut pending);
  }

  fn on_error(&self, error: rspack_error::Error) {
    let mut pending = self.pending.lock().expect("pending events poisoned");
    if pending.closed {
      return;
    }
    pending
      .errors
      .push_back(napi::Error::from_reason(format!("Watcher error: {error}")));
    self.schedule(&mut pending);
  }
}

struct JsEventHandlerUndelayed {
  inner: napi::threadsafe_function::ThreadsafeFunction<
    NativeWatchUndelayedEvent,
    napi::Unknown<'static>,
    NativeWatchUndelayedEvent,
    Status,
    false,
    false,
    1,
  >,
}

impl JsEventHandlerUndelayed {
  fn new(callback: Function<'static>) -> napi::Result<Self> {
    let callback = callback
      .build_threadsafe_function::<NativeWatchUndelayedEvent>()
      .weak::<false>()
      .max_queue_size::<1>()
      .build_callback(
        move |ctx: napi::threadsafe_function::ThreadSafeCallContext<_>| Ok(ctx.value),
      )?;

    Ok(Self { inner: callback })
  }
}

impl rspack_watcher::EventHandler for JsEventHandlerUndelayed {
  fn on_change(&self, changed_file: String) -> rspack_error::Result<()> {
    self.inner.call(
      NativeWatchUndelayedEvent {
        kind: "change".to_string(),
        path: changed_file,
      },
      napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
    );
    Ok(())
  }

  fn on_delete(&self, deleted_file: String) -> rspack_error::Result<()> {
    self.inner.call(
      NativeWatchUndelayedEvent {
        kind: "remove".to_string(),
        path: deleted_file,
      },
      napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
    );
    Ok(())
  }
}
