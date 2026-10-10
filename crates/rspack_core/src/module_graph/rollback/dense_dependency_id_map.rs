use crate::DependencyId;

#[derive(Debug)]
pub struct DenseDependencyIdMap<V> {
  values: Vec<Option<V>>,
  probe_len: Option<usize>,
}

impl<V> Default for DenseDependencyIdMap<V> {
  fn default() -> Self {
    Self {
      values: Vec::new(),
      probe_len: crate::owner_probe::enabled().then_some(0),
    }
  }
}

impl<V> DenseDependencyIdMap<V> {
  #[inline]
  pub fn insert(&mut self, key: DependencyId, value: V) -> Option<V> {
    let index = key.as_u32() as usize;
    if self.values.len() <= index {
      self.values.resize_with(index + 1, || None);
    }
    let old = self.values[index].replace(value);
    if old.is_none() {
      if let Some(n) = &mut self.probe_len {
        *n += 1;
      }
    }
    old
  }

  #[inline]
  pub fn remove(&mut self, key: &DependencyId) -> Option<V> {
    let old = self
      .values
      .get_mut(key.as_u32() as usize)
      .and_then(Option::take);
    if old.is_some() {
      if let Some(n) = &mut self.probe_len {
        *n -= 1;
      }
    }
    old
  }

  #[inline]
  pub fn get(&self, key: &DependencyId) -> Option<&V> {
    self
      .values
      .get(key.as_u32() as usize)
      .and_then(Option::as_ref)
  }

  #[inline]
  pub fn get_mut(&mut self, key: &DependencyId) -> Option<&mut V> {
    self
      .values
      .get_mut(key.as_u32() as usize)
      .and_then(Option::as_mut)
  }

  #[inline]
  pub fn clear(&mut self) {
    self.values.clear();
    if let Some(n) = &mut self.probe_len {
      *n = 0;
    }
  }

  #[inline]
  pub fn iter(&self) -> impl Iterator<Item = (DependencyId, &V)> {
    self.values.iter().enumerate().filter_map(|(index, value)| {
      value
        .as_ref()
        .map(|value| (DependencyId::from(index as u32), value))
    })
  }
}

#[cfg(test)]
mod tests {
  use crate::{DependencyId, module_graph::rollback::DenseDependencyIdMap};

  #[test]
  fn supports_sparse_dependency_ids() {
    let mut map = DenseDependencyIdMap::default();
    let a = DependencyId::from(1);
    let b = DependencyId::from(8);

    assert_eq!(map.insert(b, "b"), None);
    assert_eq!(map.insert(a, "a"), None);

    assert_eq!(map.get(&a), Some(&"a"));
    assert_eq!(map.get(&b), Some(&"b"));
    assert_eq!(map.get(&DependencyId::from(3)), None);

    assert_eq!(map.iter().collect::<Vec<_>>(), vec![(a, &"a"), (b, &"b")]);
  }

  #[test]
  fn remove_returns_existing_value() {
    let mut map = DenseDependencyIdMap::default();
    let id = DependencyId::from(2);

    map.insert(id, 1);
    assert_eq!(map.remove(&id), Some(1));
    assert_eq!(map.get(&id), None);
    assert_eq!(map.remove(&id), None);
  }
}

impl<V> DenseDependencyIdMap<V> {
  pub(crate) fn owner_probe_len(&self) -> usize {
    self.probe_len.unwrap_or(0)
  }
}
