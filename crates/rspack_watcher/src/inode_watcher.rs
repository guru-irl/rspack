use std::{
  os::unix::fs::MetadataExt,
  path::Path,
  sync::{Arc, Mutex},
};

use notify::{Event, EventHandler, RecommendedWatcher, RecursiveMode, Watcher};
use rspack_paths::{InternedPath, InternedPathMap};
use rspack_util::fx_hash::FxHashMap;

type Inode = (u64, u64);

struct InodeWatch {
  path: InternedPath,
  aliases: InternedPathMap<RecursiveMode>,
}

impl InodeWatch {
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
  paths: InternedPathMap<Inode>,
  native_paths: InternedPathMap<Inode>,
  inodes: FxHashMap<Inode, InodeWatch>,
}

impl WatchAliases {
  fn covered(&self, path: &Path) -> bool {
    path.ancestors().skip(1).any(|ancestor| {
      self
        .native_paths
        .get(&InternedPath::from(ancestor))
        .is_some_and(|inode| self.inodes[inode].mode() == RecursiveMode::Recursive)
    })
  }

  fn map_event(&self, event: &mut Event) {
    event.paths = std::mem::take(&mut event.paths)
      .into_iter()
      .flat_map(|path| {
        let mut translated = Vec::new();
        for ancestor in path.ancestors() {
          let Some(inode) = self.native_paths.get(&InternedPath::from(ancestor)) else {
            continue;
          };
          let watch = &self.inodes[inode];
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

/// inotify shares a watch descriptor between symlink aliases. Keep one native
/// path per inode and report its events under every required logical path.
pub(crate) struct InodeWatcher {
  inner: RecommendedWatcher,
  aliases: Arc<Mutex<WatchAliases>>,
}

impl InodeWatcher {
  pub fn new(mut handler: impl EventHandler, config: notify::Config) -> notify::Result<Self> {
    let aliases = Arc::new(Mutex::new(WatchAliases::default()));
    let event_aliases = Arc::clone(&aliases);
    let inner = RecommendedWatcher::new(
      move |mut result: notify::Result<Event>| {
        if let Ok(event) = &mut result {
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
    let inode = (metadata.dev(), metadata.ino());
    let path = InternedPath::from(path);
    let (native_path, native_mode, covered) = {
      let aliases = self.aliases.lock().expect("watch aliases lock poisoned");
      if let Some(watch) = aliases.inodes.get(&inode) {
        (
          watch.path.clone(),
          if watch.mode() == RecursiveMode::Recursive {
            RecursiveMode::Recursive
          } else {
            mode
          },
          aliases.covered(&watch.path),
        )
      } else {
        let native_path =
          InternedPath::from(std::fs::canonicalize(&path).map_err(notify::Error::io)?);
        let covered = aliases.covered(&native_path);
        (native_path, mode, covered)
      }
    };
    // Never hold the aliases lock across notify's blocking round trip. Its
    // event reader needs that lock to translate paths.
    if !covered {
      self.inner.watch(&native_path, native_mode)?;
    }
    let mut aliases = self.aliases.lock().expect("watch aliases lock poisoned");
    aliases.paths.insert(path.clone(), inode);
    aliases.native_paths.insert(native_path.clone(), inode);
    aliases
      .inodes
      .entry(inode)
      .or_insert_with(|| InodeWatch {
        path: native_path,
        aliases: InternedPathMap::default(),
      })
      .aliases
      .insert(path, mode);
    Ok(())
  }

  pub fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
    let (native_path, old_mode, remaining_mode) = {
      let mut aliases = self.aliases.lock().expect("watch aliases lock poisoned");
      let Some(inode) = aliases.paths.remove(&InternedPath::from(path)) else {
        return Err(notify::Error::watch_not_found());
      };
      let watch = aliases.inodes.get_mut(&inode).expect("watched inode");
      let old_mode = watch.mode();
      watch.aliases.remove(&InternedPath::from(path));
      let native_path = watch.path.clone();
      let remaining_mode = (!watch.aliases.is_empty()).then(|| watch.mode());
      if remaining_mode.is_none() {
        aliases.inodes.remove(&inode);
        aliases.native_paths.remove(&native_path);
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

    let result = self.inner.unwatch(&native_path);
    if old_mode == RecursiveMode::Recursive {
      // notify removes the recursive walk, including separately required child
      // watches. Restore the surviving physical requirements through any alias.
      let retained: Vec<_> = {
        let aliases = self.aliases.lock().expect("watch aliases lock poisoned");
        aliases
          .inodes
          .values()
          .filter(|watch| {
            watch.path.starts_with(native_path.as_ref() as &Path) && !aliases.covered(&watch.path)
          })
          .map(|watch| (watch.path.clone(), watch.mode()))
          .collect()
      };
      for (path, mode) in retained {
        self.inner.watch(&path, mode)?;
      }
    }
    result
  }
}
