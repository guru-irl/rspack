use std::sync::Mutex;

use rspack_collections::{Identifier, IdentifierMap};

use crate::{ArtifactExt, ModuleId, incremental::IncrementalPasses};

/// Exact inputs to a single, unfiltered deterministic module-ID allocation.
/// Candidate order is the allocator's order, not module-graph iteration order.
#[derive(Debug, PartialEq, Eq)]
pub struct DeterministicModuleIdsInputs {
  pub candidates: Vec<(Identifier, String, Option<u32>)>,
  pub reserved_ids: Vec<ModuleId>,
  pub context: String,
  pub range: usize,
  pub max_length: usize,
  pub salt: usize,
  pub fixed_length: bool,
  pub fail_on_conflict: bool,
}

/// ID comparison and allocation inputs, owned by the module-ID pass.
#[derive(Debug, Default)]
pub struct ModuleIdsDiffArtifact {
  /// The IDs corresponding to downstream hashes before a hot ID pass started.
  /// Retained across a failed pass, and released only after hashing succeeds.
  /// Cold builds need no copy: the first rebuild reads the recovered final map.
  /// This map is never used as reservations for allocation.
  pub previous_ids: Option<IdentifierMap<ModuleId>>,
  /// The module-ID hook receives Compilation immutably. No lock is held across
  /// a hook, await, or allocation; this contains inputs only, not previous IDs.
  pub deterministic_inputs: Mutex<Option<DeterministicModuleIdsInputs>>,
}

impl ArtifactExt for ModuleIdsDiffArtifact {
  const PASS: IncrementalPasses = IncrementalPasses::MODULE_IDS;
}
