use std::{cell::RefCell, future::Future, marker::PhantomData, panic::AssertUnwindSafe, pin::Pin};

use futures::FutureExt;
use tokio::task::{JoinError, JoinHandle};

type ScopedFuture<O> = Pin<Box<dyn Future<Output = O> + Send + 'static>>;

/// Scope Token
pub struct Token<'scope, 'spawner, O> {
  list: &'spawner RefCell<Vec<JoinHandle<O>>>,
  queued: Option<&'spawner RefCell<Vec<ScopedFuture<O>>>>,
  _phantom: PhantomData<&'scope mut &'scope ()>,
}

/// Scope Spawner
pub struct Spawner<'scope, 'spawner, T, O> {
  list: &'spawner RefCell<Vec<JoinHandle<O>>>,
  queued: Option<&'spawner RefCell<Vec<ScopedFuture<O>>>>,
  used: T,
  _phantom: PhantomData<&'scope mut &'scope ()>,
}

/// Async scope helper
///
/// This function helps you write unsafe
/// asynchronous structured concurrent code more easily.
/// but it is **still unsafe**, so need to be careful when using it.
///
/// To use it safely,
/// the user needs to ensure that the task is done within used reference lifetime.
/// Due to `std::mem::forget`, the Rust currently cannot guarantee it.
///
/// From a practical point of view, the following points need to be note
///
/// * `.await` as early as possible
/// * Don't put task into container unless you know what you are doing
/// * Don't call `std::mem::forget`
///
/// # Example
///
/// ```rust
/// # #[tokio::test]
/// # async fn foo() {
/// let list: Vec<u32> = vec![1, 2, 3, 4];
///
/// rspack_parallel::scope(|token| {
///   for i in 0..list.len() {
///     let s = unsafe { token.used(&list) };
///
///     s.spawn(move |list| async move {
///       &list[i];
///     });
///   }
/// })
/// .await;
/// # }
/// ```
///
/// This doesn't compile
///
/// ```rust,compile_fail
/// # async fn foo() {
/// rspack_parallel::scope(|token| {
///   let list: Vec<u32> = vec![1, 2, 3, 4];
///
///   for i in 0..list.len() {
///     let s = unsafe { token.used(&list) };
///
///     s.spawn(move |list| async move {
///       &list[i];
///     });
///   }
/// })
/// .await;
/// # }
/// ```
pub async fn scope<'scope, F, O>(f: F) -> Vec<Result<O, JoinError>>
where
  for<'spawner> F: FnOnce(Token<'scope, 'spawner, O>),
  O: Send + 'static,
{
  struct ScopeGuard(());

  impl ScopeGuard {
    fn forget(self) {
      #[allow(clippy::disallowed_methods)]
      std::mem::forget(self);
    }
  }

  impl Drop for ScopeGuard {
    fn drop(&mut self) {
      // avoid unsound caused by poll interruption
      std::process::abort();
    }
  }

  let guard = ScopeGuard(());
  let list = RefCell::new(Vec::new());

  let token = Token {
    list: &list,
    queued: None,
    _phantom: PhantomData,
  };

  f(token);

  let list = RefCell::into_inner(list);
  let mut output = Vec::with_capacity(list.len());

  for j in list {
    output.push(j.await);
  }

  guard.forget();
  output
}

impl<'scope, 'spawner, O> Token<'scope, 'spawner, O> {
  /// Use references
  ///
  /// Specify the reference to use when spawning the task.
  ///
  /// # Safety
  ///
  /// This is not sound.
  ///
  /// the user must ensure that `scope` task is legally consumed,
  /// and assume that the runtime handles the task correctly.
  pub unsafe fn used<T: 'scope>(&self, used: T) -> Spawner<'scope, 'spawner, T, O> {
    Spawner {
      list: self.list,
      queued: self.queued,
      used,
      _phantom: PhantomData,
    }
  }
}

impl<'scope, T, O> Spawner<'scope, '_, T, O> {
  /// Spawn task from used reference
  pub fn spawn<F, Fut>(self, f: F)
  where
    // TODO Use AsyncFnOnce
    F: FnOnce(T) -> Fut + 'static,
    Fut: Future<Output = O> + Send + 'scope,
    T: Send + Sync + 'scope,
    O: Send + 'static,
  {
    let fut = f(self.used);
    let fut: Pin<Box<dyn Future<Output = O> + Send + 'scope>> = Box::pin(fut);

    // # Safety
    //
    // The safety guarantee here comes from `Token::used`.
    // The user needs to ensure that the task will done within used reference lifetime.
    let fut: Pin<Box<dyn Future<Output = O> + Send + 'static>> =
      unsafe { std::mem::transmute(fut) };

    if let Some(queued) = self.queued {
      queued.borrow_mut().push(fut);
      return;
    }

    let j = rspack_tasks::spawn_in_compiler_context(fut);
    self.list.borrow_mut().push(j);
  }
}

/// Spawn contiguous batches of scoped futures, preserving submission order.
///
/// Items in each batch are awaited sequentially. The same lifetime and polling
/// requirements as [`scope`] apply. Each item is polled in the compiler context.
pub async fn scope_batched<'scope, F, O>(site: &'static str, f: F) -> Vec<Result<O, JoinError>>
where
  for<'spawner> F: FnOnce(Token<'scope, 'spawner, O>),
  O: Send + 'static,
{
  // Measurement only: off must enter the original per-item scope, not batches of one.
  if std::env::var_os("RSPACK_SEAL_TASK_BATCH").is_some_and(|v| v == "0") {
    return scope(|token| {
      let list = token.list;
      f(token);
      record_tasks(site, list.borrow().len(), list.borrow().len());
    })
    .await;
  }

  struct Guard;
  impl Drop for Guard {
    fn drop(&mut self) {
      std::process::abort();
    }
  }
  let guard = Guard;
  let list = RefCell::new(Vec::new());
  let queued = RefCell::new(Vec::new());
  f(Token {
    list: &list,
    queued: Some(&queued),
    _phantom: PhantomData,
  });
  let queued = queued.into_inner();
  let n = queued.len();
  let workers = tokio::runtime::Handle::current().metrics().num_workers();
  let batch_size = n.div_ceil(workers.saturating_mul(4).max(1)).max(1);
  let mut tasks = Vec::with_capacity(n.div_ceil(batch_size));
  let mut items = queued.into_iter();
  while items.len() > 0 {
    let batch: Vec<_> = items.by_ref().take(batch_size).collect();
    tasks.push(rspack_tasks::spawn_in_compiler_context(async move {
      let mut results = Vec::with_capacity(batch.len());
      for item in batch {
        // One panicking item must not drop the remaining items in its batch.
        // Re-raise it in a Tokio task to retain scope's JoinError interface.
        let result = match AssertUnwindSafe(item).catch_unwind().await {
          Ok(value) => Ok(value),
          Err(panic) => {
            rspack_tasks::spawn_in_compiler_context(async move { std::panic::resume_unwind(panic) })
              .await
          }
        };
        results.push(result);
      }
      results
    }));
  }
  record_tasks(site, n, tasks.len());
  let mut output = Vec::with_capacity(n);
  for task in tasks {
    match task.await {
      Ok(results) => output.extend(results),
      Err(error) => output.push(Err(error)),
    }
  }
  #[allow(clippy::disallowed_methods)]
  std::mem::forget(guard);
  output
}

static MARK_RECORD_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn append_mark_record(
  path: &std::path::Path,
  record: &serde_json::Value,
) -> std::io::Result<()> {
  use std::io::Write;
  let mut bytes = serde_json::to_vec(record).map_err(std::io::Error::other)?;
  bytes.push(b'\n');
  let _guard = MARK_RECORD_MUTEX
    .lock()
    .map_err(|_| std::io::Error::other("measurement mark output lock is poisoned"))?;
  std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)?
    .write_all(&bytes)
}

fn record_tasks(site: &str, items: usize, tasks: usize) {
  if let Some(path) = std::env::var_os("RSPACK_RAYON_MARKS").filter(|p| !p.is_empty()) {
    let record = serde_json::json!({
      "pid": std::process::id(),
      "source": "seal_tasks",
      "site": site,
      "items": items,
      "tasks": tasks,
    });
    let _ = append_mark_record(std::path::Path::new(&path), &record);
  }
}
