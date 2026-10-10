from pathlib import Path
import sys
root = Path(sys.argv[1])

def edit(name, old, new, count=1):
    p = root / name
    text = p.read_text()
    assert text.count(old) == count, (name, old[:100], text.count(old), count)
    p.write_text(text.replace(old, new))

base = 'crates/rspack_core/src/'
(root / base / 'incremental/diagnostic.rs').write_text('''// Bench-only diagnostics. Never enabled by default.
use std::{collections::{BTreeMap, BTreeSet}, sync::{LazyLock, Mutex}, sync::atomic::{AtomicUsize, Ordering}};
static ENABLED: LazyLock<bool> = LazyLock::new(|| std::env::var("RSPACK_DIAG_INCREMENTAL").is_ok_and(|v| v == "1"));
static ORACLE: LazyLock<bool> = LazyLock::new(|| std::env::var("RSPACK_DIAG_TRANSITIVE_OFF").is_ok_and(|v| v == "1"));
static GENERATION: AtomicUsize = AtomicUsize::new(0);
#[derive(Default)]
struct Data { counts: BTreeMap<&'static str, usize>, sets: BTreeMap<&'static str, BTreeSet<u32>> }
static DATA: LazyLock<Mutex<Data>> = LazyLock::new(|| Mutex::new(Data::default()));
pub fn enabled() -> bool { *ENABLED }
pub fn transitive_off() -> bool { *ORACLE && GENERATION.load(Ordering::Relaxed) > 1 }
pub fn begin() { GENERATION.fetch_add(1, Ordering::Relaxed); if enabled() { *DATA.lock().expect("diagnostic lock") = Data::default(); } }
pub fn add(key: &'static str, value: usize) { if enabled() { *DATA.lock().expect("diagnostic lock").counts.entry(key).or_default() += value; } }
pub fn key(key: &'static str, value: u32) { if enabled() { DATA.lock().expect("diagnostic lock").sets.entry(key).or_default().insert(value); } }
pub fn has(key: &'static str, value: u32) -> bool { enabled() && DATA.lock().expect("diagnostic lock").sets.get(key).is_some_and(|s| s.contains(&value)) }
pub fn finish() {
 if !enabled() { return; }
 let data = DATA.lock().expect("diagnostic lock");
 let mut counts = data.counts.clone();
 for (key, set) in &data.sets { counts.insert(key, set.len()); }
 if let (Some(fresh), Some(split)) = (data.sets.get("chunk.fresh_hash_key"), data.sets.get("split.created")) { counts.insert("split.fresh_hash_key", fresh.intersection(split).count()); }
 if let (Some(asset), Some(split)) = (data.sets.get("asset.selected"), data.sets.get("split.created")) { counts.insert("split.asset_selected", asset.intersection(split).count()); }
 let fields = counts.iter().map(|(k,v)| format!("\\\"{k}\\\":{v}")).collect::<Vec<_>>().join(",");
 eprintln!("RSPACK_DIAG_INCREMENTAL {{\\\"generation\\\":{},{} }}", GENERATION.load(Ordering::Relaxed), fields);
}
''')
edit(base+'incremental/mod.rs', 'mod mutations;', 'pub mod diagnostic;\nmod mutations;')
edit(base+'compilation/run_passes.rs', '    self.module_static_cache.enable_new_cache();', '    crate::incremental::diagnostic::begin();\n    self.module_static_cache.enable_new_cache();')
edit(base+'compilation/run_passes.rs', '    self.module_static_cache.disable_cache();', '    self.module_static_cache.disable_cache();\n    crate::incremental::diagnostic::finish();')

m = base+'incremental/mutations.rs'
edit(m, 'match dependency.could_affect_referencing_module() {', 'match if crate::incremental::diagnostic::transitive_off() && matches!(dependency.could_affect_referencing_module(), AffectType::Transitive) { AffectType::False } else { dependency.could_affect_referencing_module() } {')
edit(m, 'match dep.could_affect_referencing_module() {', 'match if crate::incremental::diagnostic::transitive_off() && matches!(dep.could_affect_referencing_module(), AffectType::Transitive) { AffectType::False } else { dep.could_affect_referencing_module() } {')
edit(m, '  let mut all_affected_modules: IdentifierSet = built_modules.clone();', '''  let diag = crate::incremental::diagnostic::enabled();
  let mut diagnostic_direct = IdentifierSet::default();
  let mut diagnostic_transitive = IdentifierSet::default();
  crate::incremental::diagnostic::add("mg.seed", built_modules.len());
  let mut all_affected_modules: IdentifierSet = built_modules.clone();''')
edit(m, '    all_affected_modules.extend(direct_affected_modules);', '''    if diag { diagnostic_direct.extend(direct_affected_modules.iter().copied()); diagnostic_transitive.extend(transitive_affected_modules.iter().copied()); }
    all_affected_modules.extend(direct_affected_modules);''', count=2)
# In the loop the old transitive set was taken, so explicitly count new transitive too.
edit(m, '    transitive_affected_modules.extend(new_transitive_affected_modules);', '''    if diag { diagnostic_transitive.extend(new_transitive_affected_modules.iter().copied()); }
    transitive_affected_modules.extend(new_transitive_affected_modules);''')
edit(m, '  all_affected_modules\n}', '''  crate::incremental::diagnostic::add("mg.direct_unique", diagnostic_direct.len());
  crate::incremental::diagnostic::add("mg.transitive_unique", diagnostic_transitive.len());
  crate::incremental::diagnostic::add("mg.direct_transitive_overlap", diagnostic_direct.intersection(&diagnostic_transitive).count());
  crate::incremental::diagnostic::add("mg.selected", all_affected_modules.len());
  all_affected_modules
}''')
edit(m, '        let mut chunks = FxHashSet::default();', '        let diag_initial = modules.len();\n        let mut chunks = FxHashSet::default();')
edit(m, '        modules.extend(chunks.into_iter().flat_map(|chunk| {', '''        crate::incremental::diagnostic::add("mg.chunk_graph_nonadd_delta", modules.len().saturating_sub(diag_initial));
        let diag_before_add = modules.len();
        modules.extend(chunks.into_iter().flat_map(|chunk| {''')
edit(m, '        modules\n      })', '''        crate::incremental::diagnostic::add("mg.chunk_add_delta", modules.len().saturating_sub(diag_before_add));
        modules
      })''')
edit(m, '        self.iter().fold(FxHashSet::default(), |mut acc, mutation| {', '''        if crate::incremental::diagnostic::enabled() {
          for mutation in self.iter() {
            match mutation {
              Mutation::ModuleSetHashes { module } => { for c in compilation.build_chunk_graph_artifact.chunk_graph.get_module_chunks(*module) { crate::incremental::diagnostic::key("chunk.cause_module_hash", c.as_u32()); } }
              Mutation::ChunkAdd { chunk } => crate::incremental::diagnostic::key("chunk.cause_add", chunk.as_u32()),
              Mutation::ChunkSplit { from, to } => { crate::incremental::diagnostic::key("chunk.cause_split_from", from.as_u32()); crate::incremental::diagnostic::key("chunk.cause_split_to", to.as_u32()); }
              _ => {}
            }
          }
        }
        self.iter().fold(FxHashSet::default(), |mut acc, mutation| {''')

m = base+'compilation/create_module_hashes/mod.rs'
edit(m, '    // check if module runtime changes', '    let diag_before_runtime = modules.len();\n    // check if module runtime changes')
edit(m, '    tracing::debug!', '    crate::incremental::diagnostic::add("mg.runtime_change_delta", modules.len().saturating_sub(diag_before_runtime));\n    tracing::debug!')
edit(m, '  create_module_hashes(compilation, create_module_hashes_modules).await', '  crate::incremental::diagnostic::add("mg.hash_selected", create_module_hashes_modules.len());\n  create_module_hashes(compilation, create_module_hashes_modules).await')
edit(m, '      mutations.add(Mutation::ModuleSetHashes { module });', '      crate::incremental::diagnostic::add("mg.hash_changed", 1);\n      mutations.add(Mutation::ModuleSetHashes { module });')

m = base+'compilation/create_hash/mod.rs'
edit(m, '  let mut compilation_hasher = RspackHasher::from(&compilation.options.output);', '''  crate::incremental::diagnostic::add("chunk.hash_selected", create_hash_chunks.len());
  if crate::incremental::diagnostic::enabled() {
    for key in &create_hash_chunks {
      if compilation.chunk_hashes_artifact.get(key).is_none() { crate::incremental::diagnostic::key("chunk.fresh_hash_key", key.as_u32()); }
    }
  }
  let mut compilation_hasher = RspackHasher::from(&compilation.options.output);''')
edit(m, '        mutations.add(Mutation::ChunkSetHashes { chunk: chunk_ukey });', '        crate::incremental::diagnostic::key("chunk.hash_changed", chunk_ukey.as_u32());\n        mutations.add(Mutation::ChunkSetHashes { chunk: chunk_ukey });')

m = base+'compilation/create_chunk_assets/mod.rs'
edit(m, '  let compilation_ref = &*compilation;', '''  if crate::incremental::diagnostic::enabled() { for key in &chunks { crate::incremental::diagnostic::key("asset.selected", key.as_u32()); } }
  let compilation_ref = &*compilation;''')
edit(m, '    for file_manifest in manifests {', '    crate::incremental::diagnostic::add("asset.replayed_chunks", 1);\n    for file_manifest in manifests {\n      crate::incremental::diagnostic::add("asset.replayed_manifests", 1);')
m = base+'artifacts/chunk_render_cache_artifact.rs'
edit(m, '      return Ok((entry.source, Vec::new()));', '      crate::incremental::diagnostic::add("render.cache_hit", 1);\n      return Ok((entry.source, Vec::new()));')
edit(m, '    let res = generator().await?;', '    crate::incremental::diagnostic::add("render.cache_miss", 1);\n    let res = generator().await?;')
m = 'crates/rspack_plugin_split_chunks/src/plugin/chunk.rs'
edit(m, '          mutations.add(Mutation::ChunkAdd {', '          rspack_core::incremental::diagnostic::key("split.created", new_chunk_ukey.as_u32());\n          mutations.add(Mutation::ChunkAdd {')
edit(m, '        mutations.add(Mutation::ChunkAdd {', '        rspack_core::incremental::diagnostic::key("split.created", new_chunk_ukey.as_u32());\n        mutations.add(Mutation::ChunkAdd {', count=2)
# Set de-duplication makes the repeated named-path key harmless.
print('Bench-only diagnostic patch applied')
