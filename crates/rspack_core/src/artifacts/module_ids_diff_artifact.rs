use rspack_collections::IdentifierMap;

use crate::{ArtifactExt, ModuleId, incremental::IncrementalPasses};

/// Previous effective module IDs, used only for comparison after the ID hooks.
///
/// Unlike `ModuleIdsArtifact`, this state must survive global allocation resetting
/// the current IDs. It must never be used as reservations for that allocation.
#[derive(Debug, Default)]
pub struct ModuleIdsDiffArtifact {
  pub previous_ids: IdentifierMap<ModuleId>,
}

impl ArtifactExt for ModuleIdsDiffArtifact {
  const PASS: IncrementalPasses = IncrementalPasses::MODULE_IDS;
}
