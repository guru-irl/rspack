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
static LIVE: Mutex<Vec<Weak<Mutex<DiskWatcher>>>> = Mutex::new(Vec::new());
#[cfg(target_os = "linux")]
pub(crate) fn register(watcher: &Arc<Mutex<DiskWatcher>>) {
  let mut live = LIVE.lock().expect("live disk watchers lock poisoned");
  prune_live_watchers(&mut live);
  live.push(Arc::downgrade(watcher));
}
#[cfg(target_os = "linux")]
pub(crate) fn unregister(watcher: &Arc<Mutex<DiskWatcher>>) {
  let watcher = Arc::downgrade(watcher);
  let mut live = LIVE.lock().expect("live disk watchers lock poisoned");
  live.retain(|entry| !entry.ptr_eq(&watcher));
  prune_live_watchers(&mut live);
}
#[cfg(target_os = "linux")]
fn prune_live_watchers(live: &mut Vec<Weak<Mutex<DiskWatcher>>>) {
  live.retain(|watcher| watcher.strong_count() > 0);
  if live.is_empty() {
    CONTEXTS_DISABLED.store(false, Ordering::Release);
  }
}
#[cfg(target_os = "linux")]
pub(crate) fn reclaim_and_retry_all() {
  let watchers: Vec<_> = {
    let mut live = LIVE.lock().expect("live disk watchers lock poisoned");
    prune_live_watchers(&mut live);
    live.iter().filter_map(Weak::upgrade).collect()
  };
  for watcher in &watchers {
    watcher
      .lock()
      .expect("disk watcher lock poisoned")
      .release_context_only();
  }
  for watcher in &watchers {
    watcher
      .lock()
      .expect("disk watcher lock poisoned")
      .retry_missing_analyzer_patterns();
  }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct ContextWatches {
  inner: Option<RecommendedWatcher>,
  installed: HashSet<InternedPath>,
}

/// Keeps analyzer requirements on the primary stream. Linux context descendants
/// use a separate stream so they cannot overwrite a dependency's native spelling or mode.
pub struct DiskWatcher {
  inner: Option<RecommendedWatcher>,
  watch_patterns: HashSet<WatchPattern>,
  #[cfg(target_os = "linux")]
  analyzer_patterns: HashSet<WatchPattern>,
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
    let inner =
      native_watcher(Arc::clone(&trigger), config).expect("Failed to create disk watcher");
    Self {
      inner: Some(inner),
      watch_patterns: HashSet::default(),
      #[cfg(target_os = "linux")]
      analyzer_patterns: HashSet::default(),
      #[cfg(target_os = "linux")]
      context_paths: HashSet::default(),
      #[cfg(target_os = "linux")]
      contexts: Arc::new(Mutex::new(ContextWatches::default())),
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
    {
      self.analyzer_patterns = new_patterns.clone();
    }
    let stale_paths: HashSet<InternedPath> = self
      .watch_patterns
      .iter()
      .filter(|p| !new_patterns.contains(p))
      .map(|p| p.path.clone())
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
      if self.watch_patterns.contains(&pattern) {
        continue;
      }
      if let Err(error) = self.watch_pattern(&pattern) {
        #[cfg(target_os = "linux")]
        if matches!(error.kind, notify::ErrorKind::MaxFilesWatch) {
          CONTEXTS_DISABLED.store(true, Ordering::Release);
          self.reclaim_requested = true;
          continue;
        }
        return Err(rspack_error::error!(error.to_string()));
      }
      self.watch_patterns.insert(pattern);
    }
    #[cfg(target_os = "linux")]
    self.reconcile_contexts();
    Ok(())
  }

  fn watch_pattern(&mut self, pattern: &WatchPattern) -> notify::Result<()> {
    self
      .inner
      .as_mut()
      .map_or(Ok(()), |watcher| watcher.watch(&pattern.path, pattern.mode))
  }

  #[cfg(target_os = "linux")]
  pub(crate) fn take_reclaim_request(&mut self) -> bool {
    std::mem::take(&mut self.reclaim_requested)
  }

  #[cfg(target_os = "linux")]
  fn release_context_only(&mut self) {
    let mut contexts = self.contexts.lock().expect("context watcher lock poisoned");
    let paths = std::mem::take(&mut contexts.installed);
    if let Some(watcher) = &mut contexts.inner {
      for path in paths {
        let _ = watcher.unwatch(&path);
      }
    }
    contexts.inner.take();
  }

  #[cfg(target_os = "linux")]
  fn retry_missing_analyzer_patterns(&mut self) {
    if self.inner.is_none() {
      return;
    }
    let patterns: Vec<_> = self
      .analyzer_patterns
      .difference(&self.watch_patterns)
      .cloned()
      .collect();
    for pattern in patterns {
      match self.watch_pattern(&pattern) {
        Ok(()) => {
          self.watch_patterns.insert(pattern);
        }
        Err(error) => {
          eprintln!("Error in file watcher: {error:?}");
        }
      }
    }
  }

  #[cfg(target_os = "linux")]
  fn required_coverage(&self, path: &InternedPath) -> bool {
    self
      .watch_patterns
      .iter()
      .any(|p| p.path == *path || (p.mode == Recursive && path.starts_with(&p.path)))
  }

  #[cfg(target_os = "linux")]
  fn reconcile_contexts(&mut self) {
    let paths: Vec<_> = self.context_paths.iter().cloned().collect();
    for path in paths {
      if self.required_coverage(&path) {
        let mut contexts = self.contexts.lock().expect("context watcher lock poisoned");
        if contexts.installed.remove(&path)
          && let Some(watcher) = &mut contexts.inner
        {
          let _ = watcher.unwatch(&path);
        }
      } else {
        let _ = self.watch_context_directory(&path);
      }
    }
  }

  #[cfg(target_os = "linux")]
  pub(crate) fn watch_context_directory(
    &mut self,
    path: &InternedPath,
  ) -> rspack_error::Result<bool> {
    if self.inner.is_none() {
      return Ok(false);
    }
    let added = self.context_paths.insert(path.clone());
    if self.required_coverage(path) || CONTEXTS_DISABLED.load(Ordering::Acquire) {
      return Ok(added);
    }
    let mut contexts = self.contexts.lock().expect("context watcher lock poisoned");
    if contexts.installed.contains(path) {
      return Ok(added);
    }
    if contexts.inner.is_none() {
      let Some(trigger) = self.trigger.upgrade() else {
        return Ok(added);
      };
      let Ok(watcher) = native_watcher(trigger, self.config) else {
        return Ok(added);
      };
      contexts.inner = Some(watcher);
    }
    contexts
      .inner
      .as_mut()
      .expect("optional watcher")
      .watch(path, NonRecursive)
      .map_err(|error| {
        rspack_error::error!("failed to watch context directory {path:?}: {error}")
      })?;
    contexts.installed.insert(path.clone());
    Ok(added)
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
    self.release_context_only();
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
