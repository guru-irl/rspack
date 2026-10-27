use std::path::Path;

use rspack_paths::InternedPath;
use rspack_util::fx_hash::FxHashSet;

pub(crate) fn collapse_paths(paths: &mut Vec<InternedPath>) {
  paths.sort_unstable_by(|left, right| left.as_path().cmp(right.as_path()));
  paths.dedup_by(|path, ancestor| path.starts_with(ancestor.as_path()));
}

/// Component-prefix matching without a registration-by-root cross product.
pub(crate) struct PathPrefixes<'a> {
  paths: &'a [InternedPath],
  indexed: Option<FxHashSet<&'a Path>>,
}

impl<'a> PathPrefixes<'a> {
  pub(crate) fn new(paths: &'a mut Vec<InternedPath>) -> Self {
    collapse_paths(paths);
    let paths = paths.as_slice();
    let indexed = (paths.len() > 8).then(|| paths.iter().map(|path| path.as_path()).collect());
    Self { paths, indexed }
  }

  pub(crate) fn is_empty(&self) -> bool {
    self.paths.is_empty()
  }

  pub(crate) fn contains(&self, path: &Path) -> bool {
    if let Some(paths) = &self.indexed {
      // Path Hash/Eq, unlike Unix interned keys, also match raw aliases.
      path.ancestors().any(|ancestor| paths.contains(ancestor))
    } else {
      self
        .paths
        .iter()
        .any(|root| path.starts_with(root.as_path()))
    }
  }
}
