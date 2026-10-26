use std::{
  os::unix::fs::MetadataExt,
  path::Path,
  sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
  },
};

use notify::{Event, EventHandler, RecommendedWatcher, RecursiveMode, Watcher};
use rspack_paths::{InternedPath, InternedPathMap};
use rspack_util::fx_hash::FxHashMap;

type FileId = (u64, u64);

struct CanonicalWatch {
  path: InternedPath,
  file_id: FileId,
  aliases: InternedPathMap<RecursiveMode>,
}

impl CanonicalWatch {
  fn needs_mapping(&self) -> bool {
    self.aliases.len() != 1 || !self.aliases.contains_key(&self.path)
  }

  fn is_current(&self) -> bool {
    self
      .path
      .metadata()
      .is_ok_and(|metadata| (metadata.dev(), metadata.ino()) == self.file_id)
  }

  fn mode(&self) -> RecursiveMode {
    if self
      .aliases
      .values()
      .any(|mode| *mode == RecursiveMode::Recursive)
    {
      RecursiveMode::Recursive
    } else {
      RecursiveMode::NonRecursive
    }
  }
}

#[derive(Default)]
struct WatchAliases {
  /// Logical paths retain their registration key, even after deletion.
  paths: InternedPathMap<InternedPath>,
  watches: InternedPathMap<CanonicalWatch>,
  /// Find old registrations when a directory moves or its inode is recycled.
  file_ids: FxHashMap<FileId, InternedPath>,
  mapping_count: Arc<AtomicUsize>,
}

impl WatchAliases {
  fn update_mapping(&self, before: bool, after: bool) {
    if before != after {
      if after {
        self.mapping_count.fetch_add(1, Ordering::Relaxed);
      } else {
        self.mapping_count.fetch_sub(1, Ordering::Relaxed);
      }
    }
  }

  fn remove_watch(&mut self, key: &InternedPath) -> Option<CanonicalWatch> {
    let watch = self.watches.remove(key)?;
    self.update_mapping(watch.needs_mapping(), false);
    for alias in watch.aliases.keys() {
      if self.paths.get(alias) == Some(key) {
        self.paths.remove(alias);
      }
    }
    if self.file_ids.get(&watch.file_id) == Some(key) {
      self.file_ids.remove(&watch.file_id);
    }
    Some(watch)
  }

  fn covered(&self, path: &Path) -> bool {
    path.ancestors().skip(1).any(|ancestor| {
      self
        .watches
        .get(&InternedPath::from(ancestor))
        .is_some_and(|watch| watch.mode() == RecursiveMode::Recursive)
    })
  }

  fn map_event(&self, event: &mut Event) {
    event.paths = std::mem::take(&mut event.paths)
      .into_iter()
      .flat_map(|path| {
        let mut translated = Vec::new();
        for ancestor in path.ancestors() {
          let Some(watch) = self.watches.get(&InternedPath::from(ancestor)) else {
            continue;
          };
          let suffix = path.strip_prefix(ancestor).expect("watched ancestor");
          for (alias, mode) in &watch.aliases {
            if ancestor == path
              || Some(ancestor) == path.parent()
              || *mode == RecursiveMode::Recursive
            {
              let alias_path = if ancestor == path {
                alias.to_path_buf()
              } else {
                alias.join(suffix)
              };
              if !translated.contains(&alias_path) {
                translated.push(alias_path);
              }
            }
          }
        }
        if translated.is_empty() {
          vec![path]
        } else {
          translated
        }
      })
      .collect();
  }
}

/// notify shares a watch descriptor across aliases. Store one canonical path
/// with all logical requirements and report events under every required alias.
pub(crate) struct CanonicalWatcher {
  inner: RecommendedWatcher,
  aliases: Arc<Mutex<WatchAliases>>,
}

impl CanonicalWatcher {
  pub fn new(mut handler: impl EventHandler, config: notify::Config) -> notify::Result<Self> {
    let state = WatchAliases::default();
    let mapping_count = Arc::clone(&state.mapping_count);
    let aliases = Arc::new(Mutex::new(state));
    let event_aliases = Arc::clone(&aliases);
    let inner = RecommendedWatcher::new(
      move |mut result: notify::Result<Event>| {
        if mapping_count.load(Ordering::Relaxed) != 0
          && let Ok(event) = &mut result
        {
          event_aliases
            .lock()
            .expect("watch aliases lock poisoned")
            .map_event(event);
        }
        handler.handle_event(result);
      },
      config,
    )?;
    Ok(Self { inner, aliases })
  }

  pub fn watch(&mut self, path: &Path, mode: RecursiveMode) -> notify::Result<()> {
    let metadata = path.metadata().map_err(notify::Error::io)?;
    let file_id = (metadata.dev(), metadata.ino());
    let canonical = InternedPath::from(std::fs::canonicalize(path).map_err(notify::Error::io)?);
    let path = InternedPath::from(path);
    let stale = {
      let mut aliases = self.aliases.lock().expect("watch aliases lock poisoned");
      let keys = [
        aliases.file_ids.get(&file_id).cloned(),
        Some(canonical.clone()),
      ];
      let mut stale = Vec::new();
      for key in keys.into_iter().flatten() {
        if aliases
          .watches
          .get(&key)
          .is_some_and(|watch| !watch.is_current())
        {
          stale.push(aliases.remove_watch(&key).expect("stale canonical watch"));
        }
      }
      stale
    };
    for watch in stale {
      self.remove_native_watch(&watch.path, watch.mode(), true)?;
    }
    let (native_path, native_mode, covered, needs_watch) = {
      let aliases = self.aliases.lock().expect("watch aliases lock poisoned");
      let key = aliases.file_ids.get(&file_id).unwrap_or(&canonical);
      if let Some(watch) = aliases.watches.get(key) {
        (
          watch.path.clone(),
          if watch.mode() == RecursiveMode::Recursive {
            RecursiveMode::Recursive
          } else {
            mode
          },
          aliases.covered(&watch.path),
          watch.mode() != RecursiveMode::Recursive && mode == RecursiveMode::Recursive,
        )
      } else {
        let covered = aliases.covered(&canonical);
        (canonical, mode, covered, true)
      }
    };
    // Never hold the aliases lock across notify's blocking round trip. Its
    // event reader needs that lock to translate paths.
    if !covered && needs_watch {
      self.inner.watch(&native_path, native_mode)?;
    }
    let mut aliases = self.aliases.lock().expect("watch aliases lock poisoned");
    aliases.paths.insert(path.clone(), native_path.clone());
    aliases.file_ids.insert(file_id, native_path.clone());
    let watch = aliases
      .watches
      .entry(native_path.clone())
      .or_insert_with(|| CanonicalWatch {
        path: native_path,
        file_id,
        aliases: InternedPathMap::default(),
      });
    let before = !watch.aliases.is_empty() && watch.needs_mapping();
    watch.aliases.insert(path, mode);
    let after = watch.needs_mapping();
    aliases.update_mapping(before, after);
    Ok(())
  }

  pub fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
    let (native_path, old_mode, remaining_mode) = {
      let mut aliases = self.aliases.lock().expect("watch aliases lock poisoned");
      let Some(key) = aliases.paths.remove(&InternedPath::from(path)) else {
        return Err(notify::Error::watch_not_found());
      };
      let watch = aliases.watches.get_mut(&key).expect("canonical watch");
      let old_mode = watch.mode();
      let before = watch.needs_mapping();
      watch.aliases.remove(&InternedPath::from(path));
      let native_path = watch.path.clone();
      let file_id = watch.file_id;
      let remaining_mode = (!watch.aliases.is_empty()).then(|| watch.mode());
      let after = remaining_mode.is_some() && watch.needs_mapping();
      aliases.update_mapping(before, after);
      if remaining_mode.is_none() {
        aliases.watches.remove(&key);
        if aliases.file_ids.get(&file_id) == Some(&key) {
          aliases.file_ids.remove(&file_id);
        }
      }
      (native_path, old_mode, remaining_mode)
    };
    if remaining_mode == Some(old_mode)
      || self
        .aliases
        .lock()
        .expect("watch aliases lock poisoned")
        .covered(&native_path)
    {
      return Ok(());
    }
    self.remove_native_watch(&native_path, old_mode, false)
  }

  fn remove_native_watch(
    &mut self,
    native_path: &Path,
    old_mode: RecursiveMode,
    stale: bool,
  ) -> notify::Result<()> {
    let result = self.inner.unwatch(native_path);
    let mut errors: Vec<_> = if stale {
      Vec::new()
    } else {
      result.err().into_iter().collect()
    };
    if old_mode == RecursiveMode::Recursive {
      // notify removes the recursive walk, including separately required child
      // watches. Restore the surviving physical requirements through any alias.
      let retained: Vec<_> = {
        let aliases = self.aliases.lock().expect("watch aliases lock poisoned");
        aliases
          .watches
          .values()
          .filter(|watch| watch.path.starts_with(native_path) && !aliases.covered(&watch.path))
          .map(|watch| (watch.path.clone(), watch.mode()))
          .collect()
      };
      for (path, mode) in retained {
        let mut aliases = self.aliases.lock().expect("watch aliases lock poisoned");
        if aliases
          .watches
          .get(&path)
          .is_some_and(|watch| !watch.is_current())
        {
          aliases.remove_watch(&path);
          continue;
        }
        drop(aliases);
        if let Err(error) = self.inner.watch(&path, mode) {
          tracing::warn!(target: "rspack_watcher::disk_watcher", ?path, "failed to restore watch: {error}");
          errors.push(error);
        }
      }
    }
    if errors.is_empty() {
      Ok(())
    } else if errors.len() == 1 {
      Err(errors.remove(0))
    } else {
      Err(notify::Error::generic(&format!(
        "{} watch operations failed: {}",
        errors.len(),
        errors
          .iter()
          .map(ToString::to_string)
          .collect::<Vec<_>>()
          .join("; ")
      )))
    }
  }
}
