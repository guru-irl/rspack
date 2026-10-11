use futures::{StreamExt, stream};
use rspack_error::Error;

use super::*;
use crate::{
  GroupBatchGetters,
  options::{
    cache_group_test::CacheGroupTestFnCtx,
    chunk_name::{ChunkNameBatchGetterFnCtx, ChunkNameGetterFnCtx},
  },
};

const JS_TEST_BATCH_SIZE: usize = 2048;
const JS_CHUNKS_BATCH_SIZE: usize = 8192;
const JS_CHUNK_NAME_BATCH_SIZE: usize = 1024;
const JS_BATCH_WINDOW: usize = 2;
const SCALAR_WINDOW: usize = 256;
const ROUND_REFERENCE_LIMIT: usize = 131_072;
// Keep items, selected chunks and names cache-local even for short combinations.
const ROUND_MODULE_LIMIT: usize = 16384;

struct Failures {
  bits: Vec<u64>,
  first: Option<(u32, Error)>,
}

impl Failures {
  fn new(modules: usize) -> Self {
    Self {
      bits: vec![0; modules.div_ceil(64)],
      first: None,
    }
  }

  fn contains(&self, index: u32) -> bool {
    self.bits[index as usize / 64] & (1 << (index % 64)) != 0
  }

  fn record(&mut self, index: u32, error: Error) {
    self.bits[index as usize / 64] |= 1 << (index % 64);
    if self.first.as_ref().is_none_or(|(first, _)| index < *first) {
      self.first = Some((index, error));
    }
  }
}

// Each cursor resumes the exact order of ChunkCombinationsIter without holding
// a future or allocating a combination list for every module.
impl<'a> ChunkCombinations<'a> {
  fn next_combination(&self, cursor: &mut [u32; 2]) -> Option<&'a ChunkCombination> {
    match self {
      Self::Slice(values) => {
        let value = values.get(cursor[1] as usize)?;
        cursor[1] += 1;
        Some(value)
      }
      Self::UsedExports {
        keys,
        combinations,
        include_intersections,
      } => loop {
        let key = keys.get(cursor[0] as usize)?;
        let values = combinations
          .get(key)
          .expect("prepared chunk set")
          .get(*include_intersections);
        if let Some(value) = values.get(cursor[1] as usize) {
          cursor[1] += 1;
          return Some(value);
        }
        cursor[0] += 1;
        cursor[1] = 0;
      },
    }
  }
}

struct MemoEntry<'a> {
  combination: &'a ChunkCombination,
  selected: Option<FxHashSet<ChunkUkey>>,
  pending: bool,
}

#[derive(Default)]
struct PhaseMemo<'a> {
  indices: FxHashMap<ChunksKey, Vec<usize>>,
  entries: Vec<MemoEntry<'a>>,
}

impl<'a> PhaseMemo<'a> {
  fn entry(&mut self, combination: &'a ChunkCombination) -> usize {
    let indices = self.indices.entry(combination.key).or_default();
    if let Some(index) = indices.iter().copied().find(|index| {
      let stored = self.entries[*index].combination;
      Arc::ptr_eq(&stored.data, &combination.data) || stored.data.chunks == combination.data.chunks
    }) {
      return index;
    }
    let index = self.entries.len();
    indices.push(index);
    self.entries.push(MemoEntry {
      combination,
      selected: None,
      pending: false,
    });
    index
  }
}

// Both ordinary rounds and failed memo retries use the same filtering future.
// Only iteration differs; keep the transport and buffered streams monomorphic.
enum FilterCombinations<'a, 'b> {
  Pending {
    entries: &'b [MemoEntry<'a>],
    indices: std::slice::Iter<'b, usize>,
  },
  Retry(Option<&'a ChunkCombination>),
}

impl<'a> Iterator for FilterCombinations<'a, '_> {
  type Item = &'a ChunkCombination;

  fn next(&mut self) -> Option<Self::Item> {
    match self {
      Self::Pending { entries, indices } => indices.next().map(|index| entries[*index].combination),
      Self::Retry(combination) => combination.take(),
    }
  }
}

struct RoundItem<'a> {
  module: u32,
  combination: &'a ChunkCombination,
  memo: Option<usize>,
  selected: Option<SelectedChunks<'a>>,
}

// One allocation per buffer per callback stage. Only selections and names own
// per-item data; those are moved into the memo or the final module-group map.
struct RoundScratch<'a> {
  active: Vec<(u32, [u32; 2])>,
  items: Vec<RoundItem<'a>>,
  chunk_refs: Vec<ChunkUkey>,
  owners: Vec<u32>,
  pending: Vec<usize>,
  ready: Vec<usize>,
  errors: Vec<Option<Error>>,
  names: Vec<Option<String>>,
  selections: Vec<Result<FxHashSet<ChunkUkey>>>,
}

impl RoundScratch<'_> {
  fn new(modules: usize, references: usize) -> Self {
    let items = modules.min(ROUND_MODULE_LIMIT);
    let references = references.min(ROUND_REFERENCE_LIMIT);
    Self {
      active: Vec::with_capacity(modules),
      items: Vec::with_capacity(items),
      chunk_refs: Vec::with_capacity(references),
      owners: Vec::with_capacity(references),
      pending: Vec::with_capacity(items),
      ready: Vec::with_capacity(items),
      errors: Vec::with_capacity(items),
      names: Vec::with_capacity(items),
      selections: Vec::with_capacity(items),
    }
  }
}

pub(super) struct Stage<'a> {
  pub(super) plugin: &'a SplitChunksPlugin,
  pub(super) combinator: &'a Combinator,
  pub(super) all_modules: &'a [ModuleIdentifier],
  pub(super) compilation: &'a Compilation,
  pub(super) module_chunks: &'a [SsoHashSet<ChunkUkey>],
  pub(super) module_group_map: &'a FxDashMap<ModuleGroupKey, ModuleGroup>,
  pub(super) chunk_index_map: &'a FxHashMap<ChunkUkey, u32>,
}

struct Phase<'a> {
  stage: &'a Stage<'a>,
  indexed: &'a IndexedCacheGroup<'a>,
  getters: &'a GroupBatchGetters,
  include_intersections: bool,
}

impl<'a> Phase<'a> {
  fn module(&self, index: u32) -> &'a dyn Module {
    self
      .stage
      .compilation
      .get_module_graph()
      .module_by_identifier(&self.stage.all_modules[index as usize])
      .expect("should have module")
      .as_ref()
  }

  fn gather_candidates(&self, failures: &Failures, candidates: &mut Vec<u32>) {
    let group = self.indexed.cache_group;
    candidates.clear();
    candidates.extend(
      self
        .stage
        .all_modules
        .iter()
        .enumerate()
        .filter_map(|(index, _)| {
          let index = u32::try_from(index).expect("module index should fit in u32");
          (!self.stage.module_chunks[index as usize].is_empty()
            && !failures.contains(index)
            && (is_default_module_type_filter(&group.r#type) || (group.r#type)(self.module(index))))
          .then_some(index)
        }),
    );
  }

  async fn run_layer(
    &self,
    failures: &mut Failures,
    candidates: &mut Vec<u32>,
    matched: &mut Vec<u32>,
  ) {
    let group = self.indexed.cache_group;
    if !is_default_module_layer_filter(&group.layer) {
      matched.clear();
      let mut results = stream::iter(0..candidates.len())
        .map(|slot| {
          let index = candidates[slot];
          let result = group
            .layer
            .call(self.module(index).get_layer().map(ToString::to_string));
          async move { (index, result.await) }
        })
        .buffered(SCALAR_WINDOW);
      while let Some((index, result)) = results.next().await {
        match result {
          Ok(true) => matched.push(index),
          Ok(false) => {}
          Err(error) => failures.record(index, error),
        }
      }
      drop(results);
      std::mem::swap(candidates, matched);
    }
  }

  async fn run_test(
    &self,
    failures: &mut Failures,
    candidates: &[u32],
    matched: &mut Vec<u32>,
  ) -> Result<()> {
    let group = self.indexed.cache_group;
    let getters = self.getters;
    matched.clear();
    if let Some(get_test) = &getters.test {
      let mut batches = stream::iter(0..candidates.len().div_ceil(JS_TEST_BATCH_SIZE))
        .map(|batch| {
          let start = batch * JS_TEST_BATCH_SIZE;
          let indices = &candidates[start..(start + JS_TEST_BATCH_SIZE).min(candidates.len())];
          let result = get_test(
            indices
              .iter()
              .map(|index| CacheGroupTestFnCtx {
                module: self.module(*index),
                compilation: self.stage.compilation,
              })
              .collect(),
          );
          async move { (start, result.await) }
        })
        .buffered(JS_BATCH_WINDOW);
      while let Some((start, result)) = batches.next().await {
        let indices = &candidates[start..(start + JS_TEST_BATCH_SIZE).min(candidates.len())];
        let results = result?;
        assert_eq!(
          results.len(),
          indices.len(),
          "test batch should preserve item count"
        );
        for (index, result) in indices.iter().copied().zip(results) {
          match result {
            Ok(Some(true))
              if self.stage.module_chunks[index as usize].len() >= group.min_chunks as usize =>
            {
              matched.push(index)
            }
            Ok(_) => {}
            Err(error) => failures.record(index, error),
          }
        }
      }
    } else if let CacheGroupTest::Fn(test) = &group.test {
      let mut results = stream::iter(0..candidates.len())
        .map(|slot| {
          let index = candidates[slot];
          let result = test(CacheGroupTestFnCtx {
            module: self.module(index),
            compilation: self.stage.compilation,
          });
          async move { (index, result.await) }
        })
        .buffered(SCALAR_WINDOW);
      while let Some((index, result)) = results.next().await {
        match result {
          Ok(Some(true))
            if self.stage.module_chunks[index as usize].len() >= group.min_chunks as usize =>
          {
            matched.push(index)
          }
          Ok(_) => {}
          Err(error) => failures.record(index, error),
        }
      }
    } else {
      matched.extend(candidates.iter().copied().filter(|index| {
        let item = self.module(*index);
        let matched = match &group.test {
          CacheGroupTest::String(test) => item
            .name_for_condition()
            .is_some_and(|name| name.starts_with(test)),
          CacheGroupTest::RegExp(test) => item
            .name_for_condition()
            .is_some_and(|name| test.test(&name)),
          CacheGroupTest::Enabled => true,
          CacheGroupTest::Fn(_) => unreachable!("scalar callback handled separately"),
        };
        matched && self.stage.module_chunks[*index as usize].len() >= group.min_chunks as usize
      }));
    }

    Ok(())
  }

  fn merge_native_post_test(&self, matched: &[u32]) {
    let group = self.indexed.cache_group;
    let indexed = self.indexed;
    let include_intersections = self.include_intersections;
    matched.iter().for_each(|index| {
      for combination in self
        .stage
        .combinator
        .get_combinations(*index as usize, group.used_exports, include_intersections)
        .iter()
      {
        if combination.is_empty() || combination.len() < group.min_chunks as usize {
          continue;
        }
        let selected_chunks = if matches!(group.chunk_filter, ChunkFilter::All) {
          SelectedChunks::All(combination)
        } else {
          SelectedChunks::Filtered(
            combination
              .iter()
              .copied()
              .filter(|chunk| {
                group
                  .chunk_filter
                  .test_internal(chunk, self.stage.compilation)
              })
              .collect(),
          )
        };
        if selected_chunks.len() < group.min_chunks as usize {
          continue;
        }
        let name = match &group.name {
          ChunkNameGetter::String(name) => Some(name.clone()),
          ChunkNameGetter::Disabled => None,
          ChunkNameGetter::Fn(_) => {
            unreachable!("native post-test should not have a name callback")
          }
        };
        merge_matched_item_into_module_group_map(
          MatchedItem {
            module: self.module(*index),
            cache_group_index: indexed.cache_group_index,
            cache_group: group,
            selected_chunks,
          },
          name,
          self.stage.module_group_map,
          self.stage.chunk_index_map,
        );
      }
    });
  }

  // Advance at most one combination per module in each round. Sub-rounds
  // preserve module order and bound the total selected references. A single
  // oversized combination is processed alone, with streaming chunk transport.
  fn gather_round(
    &self,
    memo: &mut PhaseMemo<'a>,
    scratch: &mut RoundScratch<'a>,
    failures: &Failures,
    offset: &mut usize,
  ) {
    let group = self.indexed.cache_group;
    scratch.items.clear();
    scratch.pending.clear();
    let mut references = 0;
    while *offset < scratch.active.len() && scratch.items.len() < ROUND_MODULE_LIMIT {
      let (index, cursor) = &mut scratch.active[*offset];
      if failures.contains(*index) {
        *offset += 1;
        continue;
      }
      let previous = *cursor;
      let combinations = self.stage.combinator.get_combinations(
        *index as usize,
        group.used_exports,
        self.include_intersections,
      );
      let combination = loop {
        let Some(combination) = combinations.next_combination(cursor) else {
          *cursor = [u32::MAX; 2];
          break None;
        };
        if !combination.is_empty() && combination.len() >= group.min_chunks as usize {
          break Some(combination);
        }
      };
      let Some(combination) = combination else {
        *offset += 1;
        continue;
      };
      if !scratch.items.is_empty() && references + combination.len() > ROUND_REFERENCE_LIMIT {
        *cursor = previous;
        break;
      }
      *offset += 1;
      references += combination.len();
      let memo_index = group
        .chunk_filter
        .is_func()
        .then(|| memo.entry(combination));
      if let Some(memo_index) = memo_index {
        let entry = &mut memo.entries[memo_index];
        if entry.selected.is_none() && !entry.pending {
          entry.pending = true;
          scratch.pending.push(memo_index);
        }
      }
      scratch.items.push(RoundItem {
        module: *index,
        combination,
        memo: memo_index,
        selected: None,
      });
      if references >= ROUND_REFERENCE_LIMIT {
        break;
      }
    }
  }

  async fn select_round(
    &self,
    memo: &mut PhaseMemo<'a>,
    scratch: &mut RoundScratch<'a>,
    failures: &mut Failures,
  ) -> Result<()> {
    let group = self.indexed.cache_group;
    self
      .filter_combinations(
        FilterCombinations::Pending {
          entries: &memo.entries,
          indices: scratch.pending.iter(),
        },
        scratch.pending.len(),
        &mut scratch.chunk_refs,
        &mut scratch.owners,
        &mut scratch.selections,
      )
      .await?;
    scratch.errors.clear();
    for (index, result) in scratch
      .pending
      .iter()
      .copied()
      .zip(scratch.selections.drain(..))
    {
      let entry = &mut memo.entries[index];
      entry.pending = false;
      match result {
        Ok(selected) => {
          entry.selected = Some(selected);
          scratch.errors.push(None);
        }
        Err(error) => scratch.errors.push(Some(error)),
      }
    }
    for item in &mut scratch.items {
      let selected = if let Some(index) = item.memo {
        if memo.entries[index].selected.is_none() {
          let owner = scratch
            .pending
            .iter()
            .position(|pending| *pending == index)
            .expect("missing selection should have a pending owner");
          let error = if let Some(error) = scratch.errors[owner].take() {
            Some(error)
          } else {
            // Failed initialization is never cached. Every waiting module
            // retries independently, matching the previous OnceCell path.
            self
              .filter_combinations(
                FilterCombinations::Retry(Some(item.combination)),
                1,
                &mut scratch.chunk_refs,
                &mut scratch.owners,
                &mut scratch.selections,
              )
              .await?;
            match scratch.selections.pop().expect("one selection") {
              Ok(selected) => {
                memo.entries[index].selected = Some(selected);
                None
              }
              Err(error) => Some(error),
            }
          };
          if let Some(error) = error {
            failures.record(item.module, error);
            continue;
          }
        }
        let selected = memo.entries[index]
          .selected
          .as_ref()
          .expect("successful selection should be cached");
        SelectedChunks::Filtered(
          item
            .combination
            .iter()
            .copied()
            .filter(|chunk| selected.contains(chunk))
            .collect(),
        )
      } else if matches!(group.chunk_filter, ChunkFilter::All) {
        SelectedChunks::All(item.combination)
      } else {
        SelectedChunks::Filtered(
          item
            .combination
            .iter()
            .copied()
            .filter(|chunk| {
              group
                .chunk_filter
                .test_internal(chunk, self.stage.compilation)
            })
            .collect(),
        )
      };
      if selected.len() >= group.min_chunks as usize {
        item.selected = Some(selected);
      }
    }
    scratch.ready.clear();
    scratch.ready.extend(
      scratch
        .items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| item.selected.is_some().then_some(index)),
    );
    Ok(())
  }

  async fn run_names(&self, scratch: &mut RoundScratch<'a>, failures: &mut Failures) -> Result<()> {
    let group = self.indexed.cache_group;
    scratch.names.clear();
    scratch.names.resize_with(scratch.ready.len(), || None);
    if let Some(get_name) = &self.getters.name {
      for (indices, names) in scratch
        .ready
        .chunks(JS_CHUNK_NAME_BATCH_SIZE)
        .zip(scratch.names.chunks_mut(JS_CHUNK_NAME_BATCH_SIZE))
      {
        let contexts = indices
          .iter()
          .map(|index| {
            let item = &scratch.items[*index];
            let chunks = match item.selected.as_ref().expect("selected chunks") {
              SelectedChunks::All(combination) => Either::Right(&combination.data.chunks),
              SelectedChunks::Filtered(chunks) => Either::Left(chunks.as_slice()),
            };
            ChunkNameBatchGetterFnCtx {
              module: self.module(item.module),
              compilation: self.stage.compilation,
              chunks,
              cache_group_key: &group.key,
            }
          })
          .collect();
        // Name-batch errors win over per-module errors, as the old coordinator
        // was joined before the module tasks. Borrowed chunks are converted
        // synchronously before the getter returns its owned transport future.
        let results = get_name(contexts).await?;
        assert_eq!(
          results.len(),
          names.len(),
          "name batch should preserve item count"
        );
        for (name, result) in names.iter_mut().zip(results) {
          *name = result;
        }
      }
    } else if let ChunkNameGetter::Fn(get_name) = &group.name {
      let mut results = stream::iter(0..scratch.ready.len())
        .map(|slot| {
          let index = scratch.ready[slot];
          let chunks = scratch.items[index]
            .selected
            .as_ref()
            .expect("selected chunks")
            .iter()
            .copied()
            .collect::<Vec<_>>();
          let result = get_name(ChunkNameGetterFnCtx {
            module: self.module(scratch.items[index].module),
            compilation: self.stage.compilation,
            chunks: &chunks,
            cache_group_key: &group.key,
          });
          async move { (slot, index, result.await) }
        })
        .buffered(SCALAR_WINDOW);
      while let Some((slot, index, result)) = results.next().await {
        match result {
          Ok(name) => scratch.names[slot] = name,
          Err(error) => failures.record(scratch.items[index].module, error),
        }
      }
    } else if let ChunkNameGetter::String(name) = &group.name {
      scratch.names.fill(Some(name.clone()));
    }
    Ok(())
  }

  fn merge_round(&self, scratch: &mut RoundScratch<'a>, failures: &Failures) {
    // Merge directly from the reusable buffers. No resolved Vec and no extra
    // parallel scheduling: the previous coarse merge had no measured CPU gain.
    for (index, name) in scratch.ready.iter().copied().zip(scratch.names.drain(..)) {
      let item = &mut scratch.items[index];
      if failures.contains(item.module) {
        continue;
      }
      merge_matched_item_into_module_group_map(
        MatchedItem {
          module: self.module(item.module),
          cache_group_index: self.indexed.cache_group_index,
          cache_group: self.indexed.cache_group,
          selected_chunks: item
            .selected
            .take()
            .expect("resolved item should have selected chunks"),
        },
        name,
        self.stage.module_group_map,
        self.stage.chunk_index_map,
      );
    }
  }

  async fn run_rounds(
    &self,
    matched: &[u32],
    failures: &mut Failures,
    scratch: &mut RoundScratch<'a>,
  ) -> Result<()> {
    let mut memo = PhaseMemo::default();
    scratch.active.clear();
    scratch
      .active
      .extend(matched.iter().map(|index| (*index, [0, 0])));
    while !scratch.active.is_empty() {
      let mut offset = 0;
      while offset < scratch.active.len() {
        self.gather_round(&mut memo, scratch, failures, &mut offset);
        if scratch.items.is_empty() {
          continue;
        }
        self.select_round(&mut memo, scratch, failures).await?;
        self.run_names(scratch, failures).await?;
        self.merge_round(scratch, failures);
      }
      scratch
        .active
        .retain(|(index, cursor)| !failures.contains(*index) && cursor[0] != u32::MAX);
    }
    Ok(())
  }

  // Even a single combination larger than the reference limit is streamed
  // through the same fixed buffers. Its selected set is necessary output and
  // moves into the memo, which the base also held for each distinct combination.
  async fn filter_combinations(
    &self,
    combinations: FilterCombinations<'a, '_>,
    count: usize,
    chunks: &mut Vec<ChunkUkey>,
    owners: &mut Vec<u32>,
    selected: &mut Vec<Result<FxHashSet<ChunkUkey>>>,
  ) -> Result<()> {
    selected.clear();
    selected.resize_with(count, || Ok(FxHashSet::default()));
    let mut references = combinations.enumerate().flat_map(|(owner, combination)| {
      combination
        .iter()
        .copied()
        .map(move |chunk| (owner as u32, chunk))
    });
    loop {
      chunks.clear();
      owners.clear();
      for (owner, chunk) in references.by_ref().take(ROUND_REFERENCE_LIMIT) {
        chunks.push(chunk);
        owners.push(owner);
      }
      if chunks.is_empty() {
        break;
      }
      let mut apply = |index: usize, result: Result<bool>| {
        let entry = &mut selected[owners[index] as usize];
        if let Ok(chosen) = entry {
          match result {
            Ok(true) => {
              chosen.insert(chunks[index]);
            }
            Ok(false) => {}
            Err(error) => *entry = Err(error),
          }
        }
      };
      if let Some(get_chunks) = &self.getters.chunks {
        let mut batches = stream::iter(0..chunks.len().div_ceil(JS_CHUNKS_BATCH_SIZE))
          .map(|index| {
            let start = index * JS_CHUNKS_BATCH_SIZE;
            let chunks = &chunks[start..(start + JS_CHUNKS_BATCH_SIZE).min(chunks.len())];
            let result = get_chunks(chunks, self.stage.compilation);
            async move { (index, chunks.len(), result.await) }
          })
          .buffered(JS_BATCH_WINDOW);
        while let Some((batch, count, result)) = batches.next().await {
          let results = result?;
          assert_eq!(
            results.len(),
            count,
            "chunks batch should preserve item count"
          );
          for (index, result) in results.into_iter().enumerate() {
            apply(batch * JS_CHUNKS_BATCH_SIZE + index, result);
          }
        }
      } else {
        let mut results = stream::iter(0..chunks.len())
          .map(|index| {
            let ChunkFilter::Func(get_chunks) = &self.indexed.cache_group.chunk_filter else {
              unreachable!("scalar chunk callback should be a function")
            };
            let result = get_chunks(&chunks[index], self.stage.compilation);
            async move { (index, result.await) }
          })
          .buffered(SCALAR_WINDOW);
        while let Some((index, result)) = results.next().await {
          apply(index, result);
        }
      }
    }
    Ok(())
  }
}

pub(super) async fn prepare_callback_groups(
  stage: Stage<'_>,
  cache_groups: &[IndexedCacheGroup<'_>],
  native_positions: &[usize],
  direct_matches: &[Option<Vec<AtomicBool>>],
) -> Result<()> {
  let Stage {
    plugin,
    all_modules,
    module_chunks,
    ..
  } = &stage;
  let mut failures = Failures::new(all_modules.len());
  let mut candidates = Vec::with_capacity(all_modules.len());
  let mut matched = Vec::with_capacity(all_modules.len());
  let empty_getters = GroupBatchGetters::default();
  let mut scratch = None;
  let mut native = native_positions.iter().copied().peekable();
  for (position, indexed) in cache_groups.iter().enumerate() {
    if native.peek() == Some(&position) {
      native.next();
      continue;
    }
    let group = indexed.cache_group;
    let getters = stage
      .plugin
      .batch_getters
      .as_deref()
      .and_then(|getters| getters.get(indexed.cache_group_index as usize))
      .unwrap_or(&empty_getters);
    let phase = Phase {
      stage: &stage,
      indexed,
      getters,
      include_intersections: plugin.dedup_depth > 0
        && cache_group_uses_intersections(group, getters.name.is_some()),
    };
    phase.gather_candidates(&failures, &mut candidates);
    phase
      .run_layer(&mut failures, &mut candidates, &mut matched)
      .await;
    phase
      .run_test(&mut failures, &candidates, &mut matched)
      .await?;
    if let Some(matches) = &direct_matches[position] {
      for index in &matched {
        matches[*index as usize].store(true, Ordering::Relaxed);
      }
    }
    if !group.chunk_filter.is_func()
      && !matches!(group.name, ChunkNameGetter::Fn(_))
      && getters.name.is_none()
      && getters.chunks.is_none()
    {
      phase.merge_native_post_test(&matched);
    } else {
      let scratch = scratch.get_or_insert_with(|| {
        RoundScratch::new(
          all_modules.len(),
          module_chunks.iter().map(|chunks| chunks.len()).sum(),
        )
      });
      phase.run_rounds(&matched, &mut failures, scratch).await?;
    }
  }
  if let Some((_, error)) = failures.first {
    Err(error)
  } else {
    Ok(())
  }
}
