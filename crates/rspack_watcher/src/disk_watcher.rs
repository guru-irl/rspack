#[cfg(target_os = "linux")]
use std::sync::{
  Mutex, Weak,
  atomic::{AtomicBool, Ordering},
};
use std::{sync::Arc, time::Duration};

#[cfg(any(target_os = "linux", test))]
use notify::RecursiveMode::{NonRecursive, Recursive};
use notify::{
  Event, EventKind, RecommendedWatcher, Watcher,
  event::{ModifyKind, RenameMode},
};
use rspack_paths::InternedPath;
use rspack_util::fx_hash::FxHashSet as HashSet;

use crate::{FsEventKind, WatchPattern, analyzer::Analyzer, trigger};

#[cfg(target_os = "linux")]
static CONTEXTS_DISABLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "linux")]
static LIVE: Mutex<Vec<Weak<Mutex<ContextWatches>>>> = Mutex::new(Vec::new());
#[cfg(target_os = "linux")]
pub(crate) fn register(watcher: &Arc<Mutex<DiskWatcher>>) {
  let watcher = Arc::downgrade(&watcher.lock().expect("disk watcher lock poisoned").contexts);
  let mut live = LIVE.lock().expect("live disk watchers lock poisoned");
  prune_live_watchers(&mut live);
  live.push(watcher);
}
#[cfg(target_os = "linux")]
pub(crate) fn unregister(watcher: &Arc<Mutex<DiskWatcher>>) {
  let watcher = Arc::downgrade(&watcher.lock().expect("disk watcher lock poisoned").contexts);
  let mut live = LIVE.lock().expect("live disk watchers lock poisoned");
  live.retain(|entry| !entry.ptr_eq(&watcher));
  prune_live_watchers(&mut live);
}
#[cfg(target_os = "linux")]
fn prune_live_watchers(live: &mut Vec<Weak<Mutex<ContextWatches>>>) {
  live.retain(|watcher| watcher.strong_count() > 0);
  if live.is_empty() {
    CONTEXTS_DISABLED.store(false, Ordering::Release);
  }
}
#[cfg(target_os = "linux")]
pub(crate) fn reclaim_and_retry_all(requester: &trigger::Trigger) {
  let watchers: Vec<_> = {
    let mut live = LIVE.lock().expect("live disk watchers lock poisoned");
    prune_live_watchers(&mut live);
    CONTEXTS_DISABLED.store(true, Ordering::Release);
    live.iter().filter_map(Weak::upgrade).collect()
  };
  let mut peers = Vec::new();
  // Finish every acknowledged release before sending any peer a repair.
  for watcher in watchers {
    let mut contexts = watcher.lock().expect("context watcher lock poisoned");
    contexts.release();
    if let Some(peer) = contexts.trigger.upgrade()
      && !std::ptr::eq(peer.as_ref(), requester)
    {
      peers.push(peer);
    }
  }
  for peer in peers {
    peer.request_repair(false);
  }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct ContextWatches {
  inner: Option<RecommendedWatcher>,
  installed: HashSet<InternedPath>,
  trigger: Weak<trigger::Trigger>,
}

#[cfg(target_os = "linux")]
impl ContextWatches {
  fn release(&mut self) {
    let paths = std::mem::take(&mut self.installed);
    if let Some(watcher) = &mut self.inner {
      for path in paths {
        let _ = watcher.unwatch(&path);
      }
    }
    self.inner.take();
  }
}

/// Keeps analyzer requirements on the primary stream. Linux context descendants
/// use a separate stream so they cannot overwrite a dependency's native spelling or mode.
pub struct DiskWatcher {
  inner: Option<RecommendedWatcher>,
  watch_patterns: HashSet<WatchPattern>,
  #[cfg(target_os = "linux")]
  analyzer_patterns: HashSet<WatchPattern>,
  #[cfg(target_os = "linux")]
  dirty: HashSet<WatchPattern>,
  #[cfg(target_os = "linux")]
  context_paths: HashSet<InternedPath>,
  #[cfg(target_os = "linux")]
  contexts: Arc<Mutex<ContextWatches>>,
  #[cfg(target_os = "linux")]
  config: notify::Config,
  #[cfg(target_os = "linux")]
  trigger: Weak<trigger::Trigger>,
  #[cfg(target_os = "linux")]
  reclaim_requested: bool,
}

fn native_watcher(
  trigger: Arc<trigger::Trigger>,
  config: notify::Config,
) -> notify::Result<RecommendedWatcher> {
  RecommendedWatcher::new(
    move |result: notify::Result<Event>| match result {
      Ok(event) => handle_event(event, &trigger),
      Err(e) => {
        tracing::error!(target: "rspack_watcher::fs_event", "file watcher error: {e:?}");
        eprintln!("Error in file watcher: {e:?}");
        #[cfg(target_os = "linux")]
        if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) {
          trigger.request_repair(true);
        }
      }
    },
    config,
  )
}

impl DiskWatcher {
  pub fn new(
    follow_symlinks: bool,
    poll_interval: Option<u32>,
    trigger: Arc<trigger::Trigger>,
  ) -> Self {
    let config = match poll_interval {
      Some(poll) => notify::Config::default()
        .with_follow_symlinks(follow_symlinks)
        .with_poll_interval(Duration::from_millis(u64::from(poll))),
      None => notify::Config::default().with_follow_symlinks(follow_symlinks),
    };
    #[allow(unused_mut)]
    let mut inner = native_watcher(Arc::clone(&trigger), config);
    #[cfg(target_os = "linux")]
    if inner.is_err() {
      reclaim_and_retry_all(&trigger);
      for _ in 0..5 {
        std::thread::sleep(Duration::from_millis(20));
        inner = native_watcher(Arc::clone(&trigger), config);
        if inner.is_ok() {
          break;
        }
      }
    }
    let inner = inner.expect("Failed to create disk watcher");
    Self {
      inner: Some(inner),
      watch_patterns: HashSet::default(),
      #[cfg(target_os = "linux")]
      analyzer_patterns: HashSet::default(),
      #[cfg(target_os = "linux")]
      dirty: HashSet::default(),
      #[cfg(target_os = "linux")]
      context_paths: HashSet::default(),
      #[cfg(target_os = "linux")]
      contexts: Arc::new(Mutex::new(ContextWatches {
        trigger: Arc::downgrade(&trigger),
        ..Default::default()
      })),
      #[cfg(target_os = "linux")]
      config,
      #[cfg(target_os = "linux")]
      trigger: Arc::downgrade(&trigger),
      #[cfg(target_os = "linux")]
      reclaim_requested: false,
    }
  }

  pub fn watch(
    &mut self,
    patterns: impl Iterator<Item = WatchPattern>,
  ) -> rspack_error::Result<()> {
    let new_patterns: HashSet<_> = patterns.collect();
    #[cfg(target_os = "linux")]
    let new_patterns = {
      let recursive: HashSet<_> = new_patterns
        .iter()
        .filter(|p| p.mode == Recursive)
        .map(|p| p.path.clone())
        .collect();
      let mut new_patterns = new_patterns;
      if !recursive.is_empty() {
        new_patterns.retain(|p| p.mode == Recursive || !recursive.contains(&p.path));
      }
      new_patterns
    };
    #[cfg(target_os = "linux")]
    let previous = std::mem::replace(&mut self.analyzer_patterns, new_patterns.clone());
    #[cfg(target_os = "linux")]
    self.dirty.retain(|p| new_patterns.contains(p));
    #[cfg(target_os = "linux")]
    let required_paths: HashSet<_> = new_patterns.iter().map(|p| p.path.clone()).collect();
    let stale_paths: HashSet<InternedPath> = self
      .watch_patterns
      .iter()
      .filter(|p| {
        if new_patterns.contains(p) {
          return false;
        }
        #[cfg(target_os = "linux")]
        if new_patterns.contains(&WatchPattern {
          path: p.path.clone(),
          mode: Recursive,
        }) {
          return false;
        }
        true
      })
      .map(|p| p.path.clone())
      .collect();
    #[cfg(target_os = "linux")]
    let stale_paths: HashSet<_> = stale_paths
      .into_iter()
      .chain(
        previous
          .iter()
          .filter(|p| !required_paths.contains(&p.path))
          .map(|p| p.path.clone()),
      )
      .collect();
    for path in &stale_paths {
      if let Some(watcher) = &mut self.inner
        && let Err(e) = watcher.unwatch(path)
        && !matches!(e.kind, notify::ErrorKind::WatchNotFound)
      {
        tracing::warn!(target: "rspack_watcher::disk_watcher", ?path, "failed to unwatch stale path: {e:?}");
      }
    }
    self
      .watch_patterns
      .retain(|p| !stale_paths.contains(&p.path));
    for pattern in new_patterns {
      #[cfg(target_os = "linux")]
      let installed = self.watch_patterns.contains(&pattern) && !self.dirty.contains(&pattern);
      #[cfg(not(target_os = "linux"))]
      let installed = self.watch_patterns.contains(&pattern);
      if installed {
        continue;
      }
      if let Err(error) = self.watch_pattern(&pattern) {
        #[cfg(target_os = "linux")]
        if matches!(error.kind, notify::ErrorKind::MaxFilesWatch) {
          self.reclaim_requested = true;
        }
        return Err(rspack_error::error!(error.to_string()));
      }
      #[cfg(target_os = "linux")]
      self.dirty.remove(&pattern);
      self.watch_patterns.retain(|p| p.path != pattern.path);
      self.watch_patterns.insert(pattern);
    }
    #[cfg(target_os = "linux")]
    self.reconcile_contexts();
    Ok(())
  }

  fn watch_pattern(&mut self, pattern: &WatchPattern) -> notify::Result<()> {
    let result = self
      .inner
      .as_mut()
      .map_or(Ok(()), |watcher| watcher.watch(&pattern.path, pattern.mode));
    #[cfg(target_os = "linux")]
    if result.is_err()
      && pattern.mode == Recursive
      && self.watch_patterns.contains(&WatchPattern {
        path: pattern.path.clone(),
        mode: NonRecursive,
      })
      && let Some(watcher) = &mut self.inner
    {
      let _ = watcher.watch(&pattern.path, NonRecursive);
    }
    result
  }

  #[cfg(target_os = "linux")]
  pub(crate) fn take_reclaim_request(&mut self) -> bool {
    std::mem::take(&mut self.reclaim_requested)
  }

  #[cfg(target_os = "linux")]
  fn release_context_only(&mut self) {
    self
      .contexts
      .lock()
      .expect("context watcher lock poisoned")
      .release();
  }

  #[cfg(target_os = "linux")]
  pub(crate) fn repair(&mut self, recursive: bool) -> rspack_error::Result<bool> {
    if self.inner.is_none() {
      return Ok(false);
    }
    let patterns: Vec<_> = self
      .analyzer_patterns
      .iter()
      .filter(|p| {
        (recursive && p.mode == Recursive)
          || self.dirty.contains(p)
          || !self.watch_patterns.contains(p)
      })
      .cloned()
      .collect();
    let repaired = !patterns.is_empty();
    let mut failure = None;
    for pattern in patterns {
      match self.watch_pattern(&pattern) {
        Ok(()) => {
          self.dirty.remove(&pattern);
          self.watch_patterns.retain(|p| p.path != pattern.path);
          self.watch_patterns.insert(pattern);
        }
        Err(error) => {
          self.dirty.insert(pattern);
          failure.get_or_insert(error);
        }
      }
    }
    if let Some(error) = failure {
      return Err(rspack_error::error!(error.to_string()));
    }
    self.reconcile_contexts();
    Ok(repaired)
  }

  #[cfg(target_os = "linux")]
  fn reconcile_contexts(&mut self) {
    let paths: Vec<_> = self.context_paths.iter().cloned().collect();
    for path in paths {
      self.watch_context_directory(&path);
    }
  }

  #[cfg(target_os = "linux")]
  pub(crate) fn watch_context_directory(&mut self, path: &InternedPath) {
    if self.inner.is_none() {
      return;
    }
    self.context_paths.insert(path.clone());
    // A required pattern is not proof that notify kept the inherited descriptor.
    // Give every owned context directory a confirmed lease on the isolated stream.
    let mut contexts = self.contexts.lock().expect("context watcher lock poisoned");
    // Recheck under the slot lock so a concurrent release cannot miss an addition.
    if CONTEXTS_DISABLED.load(Ordering::Acquire) || contexts.installed.contains(path) {
      return;
    }
    if contexts.inner.is_none() {
      let Some(trigger) = self.trigger.upgrade() else {
        return;
      };
      let Ok(watcher) = native_watcher(trigger, self.config) else {
        return;
      };
      contexts.inner = Some(watcher);
    }
    match contexts
      .inner
      .as_mut()
      .expect("optional watcher")
      .watch(path, NonRecursive)
    {
      Ok(()) => {
        contexts.installed.insert(path.clone());
      }
      Err(error) if matches!(error.kind, notify::ErrorKind::MaxFilesWatch) => {
        CONTEXTS_DISABLED.store(true, Ordering::Release);
        if let Some(trigger) = self.trigger.upgrade() {
          trigger.request_repair(true);
        }
      }
      Err(_) => {}
    }
  }

  #[cfg(target_os = "linux")]
  pub(crate) fn remove_context_directory(&mut self, path: &InternedPath, _removed: bool) {
    self.context_paths.remove(path);
    let mut contexts = self.contexts.lock().expect("context watcher lock poisoned");
    if contexts.installed.remove(path)
      && let Some(watcher) = &mut contexts.inner
    {
      let _ = watcher.unwatch(path);
    }
  }

  pub fn close(&mut self) {
    #[cfg(target_os = "linux")]
    {
      self.release_context_only();
      self
        .contexts
        .lock()
        .expect("context watcher lock poisoned")
        .trigger = Weak::new();
    }
    self.inner.take();
  }
}

pub(crate) fn handle_event(event: Event, trigger: &trigger::Trigger) {
  tracing::debug!(
    target: "rspack_watcher::fs_event",
    kind = ?event.kind,
    paths = ?event.paths,
    "fs_event",
  );

  if event.need_rescan() {
    trigger.analyzer.invalidate_all();
  }
  if event.paths.is_empty() {
    return;
  }

  for (index, path) in event.paths.into_iter().map(InternedPath::from).enumerate() {
    let kind = match event.kind {
      EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
        FsEventKind::Create
      }
      EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
        FsEventKind::Remove
      }
      EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
        if index == 0 {
          FsEventKind::Remove
        } else {
          FsEventKind::Create
        }
      }
      EventKind::Modify(
        ModifyKind::Data(_) | ModifyKind::Any | ModifyKind::Name(_) | ModifyKind::Metadata(_),
      ) => FsEventKind::Change,
      _ => return,
    };
    let appeared = kind == FsEventKind::Create
      || matches!(
        event.kind,
        EventKind::Modify(ModifyKind::Name(RenameMode::Any))
      );
    // Content writes cannot change which ancestor directory exists.
    // Invalidate before filtering so suppressed events still refresh watch coverage.
    if !matches!(event.kind, EventKind::Modify(ModifyKind::Data(_))) {
      trigger.analyzer.invalidate_path(&path);
    }
    trigger.on_disk_event(&path, kind, appeared);
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Arc;

  use rspack_paths::InternedPath;
  use tokio::sync::mpsc;

  use super::*;
  use crate::paths::PathManager;

  fn create_disk_watcher() -> DiskWatcher {
    let (tx, _rx) = mpsc::unbounded_channel();
    let path_manager = Arc::new(PathManager::default());
    let trigger = Arc::new(trigger::Trigger::new(path_manager, tx));
    DiskWatcher::new(false, None, trigger)
  }

  #[test]
  fn test_watch_removes_stale_patterns() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let base = temp_dir.path().canonicalize().unwrap();

    let dir_a = base.join("a");
    let dir_b = base.join("b");
    let dir_c = base.join("c");
    std::fs::create_dir_all(&dir_a).unwrap();
    std::fs::create_dir_all(&dir_b).unwrap();
    std::fs::create_dir_all(&dir_c).unwrap();

    let mut watcher = create_disk_watcher();

    // First watch: {A, B}
    watcher
      .watch(
        vec![
          WatchPattern {
            path: InternedPath::from(dir_a.clone()),
            mode: NonRecursive,
          },
          WatchPattern {
            path: InternedPath::from(dir_b.clone()),
            mode: NonRecursive,
          },
        ]
        .into_iter(),
      )
      .unwrap();
    assert_eq!(watcher.watch_patterns.len(), 2);

    // Second watch: {B, C} — A should be removed
    watcher
      .watch(
        vec![
          WatchPattern {
            path: InternedPath::from(dir_b.clone()),
            mode: NonRecursive,
          },
          WatchPattern {
            path: InternedPath::from(dir_c.clone()),
            mode: NonRecursive,
          },
        ]
        .into_iter(),
      )
      .unwrap();

    assert_eq!(watcher.watch_patterns.len(), 2);
    let paths: HashSet<_> = watcher
      .watch_patterns
      .iter()
      .map(|p| p.path.clone())
      .collect();
    assert!(paths.contains(&InternedPath::from(dir_b)));
    assert!(paths.contains(&InternedPath::from(dir_c)));
    assert!(!paths.contains(&InternedPath::from(dir_a)));
  }

  #[cfg(target_os = "linux")]
  #[test]
  fn test_watch_continues_after_unwatch_of_deleted_subdirectory() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let base = temp_dir.path().canonicalize().unwrap();

    let dir = base.join("dir");
    let other = base.join("other");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(&other).unwrap();

    let mut watcher = create_disk_watcher();
    watcher
      .watch(
        vec![WatchPattern {
          path: InternedPath::from(dir.clone()),
          mode: Recursive,
        }]
        .into_iter(),
      )
      .unwrap();

    // Let the inotify backend add and then drop a watch for the subdirectory.
    let sub = dir.join("sub");
    std::fs::create_dir(&sub).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    std::fs::remove_dir(&sub).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Unwatching `dir` can fail for the deleted subdirectory; `other` must still be watched.
    watcher
      .watch(
        vec![WatchPattern {
          path: InternedPath::from(other.clone()),
          mode: NonRecursive,
        }]
        .into_iter(),
      )
      .unwrap();

    let paths: HashSet<_> = watcher
      .watch_patterns
      .iter()
      .map(|p| p.path.clone())
      .collect();
    assert_eq!(paths.len(), 1);
    assert!(paths.contains(&InternedPath::from(other)));
  }
}
