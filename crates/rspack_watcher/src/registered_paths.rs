use std::{cmp::Ordering, collections::BTreeSet};

use rspack_paths::InternedPath;

/// Component-ordered registrations, independent of their timestamp records.
#[derive(Debug, Default)]
pub(super) struct RegisteredPaths {
  paths: BTreeSet<Key>,
}

/// A range starts before every spelling of its first component path.
#[derive(Debug)]
enum Key {
  Before(InternedPath),
  Registered(InternedPath),
}

impl Key {
  fn path(&self) -> &InternedPath {
    match self {
      Self::Before(path) | Self::Registered(path) => path,
    }
  }
}

impl Ord for Key {
  fn cmp(&self, other: &Self) -> Ordering {
    self
      .path()
      .as_path()
      .cmp(other.path().as_path())
      .then_with(|| match (self, other) {
        (Self::Before(_), Self::Before(_)) => Ordering::Equal,
        (Self::Before(_), Self::Registered(_)) => Ordering::Less,
        (Self::Registered(_), Self::Before(_)) => Ordering::Greater,
        (Self::Registered(left), Self::Registered(right)) => {
          left.as_os_str().cmp(right.as_os_str())
        }
      })
  }
}

impl PartialOrd for Key {
  fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
    Some(self.cmp(other))
  }
}

impl PartialEq for Key {
  fn eq(&self, other: &Self) -> bool {
    self.cmp(other) == Ordering::Equal
  }
}

impl Eq for Key {}

impl RegisteredPaths {
  pub(super) fn insert(&mut self, path: InternedPath) {
    self.paths.insert(Key::Registered(path));
  }

  pub(super) fn remove(&mut self, path: &InternedPath) {
    self.paths.remove(&Key::Registered(path.clone()));
  }

  pub(super) fn for_each_under(&self, path: &InternedPath, mut visit: impl FnMut(&InternedPath)) {
    for key in self.paths.range(Key::Before(path.clone())..) {
      let registered = key.path();
      if !registered.starts_with(path.as_path()) {
        break;
      }
      visit(registered);
    }
  }
}

pub(super) fn collapse_deleted_paths(paths: &mut Vec<InternedPath>) {
  paths.sort_unstable_by(|left, right| left.as_path().cmp(right.as_path()));
  paths.dedup_by(|path, ancestor| path.starts_with(ancestor.as_path()));
}
