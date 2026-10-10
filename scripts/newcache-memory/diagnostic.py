from pathlib import Path
import subprocess
import tarfile

manifest = Path('Cargo.toml')
s = manifest.read_text()
old = 'turbo-persistence   = { package = "rspack-turbo-persistence", version = "0.1.1", default-features = false }'
assert old in s
manifest.write_text(s.replace(old, old[:-2] + ', features = ["stats"] }'))
source = Path('crates/rspack_core/src/new_cache/db/turbo.rs')
s = source.read_text()
old = '  pub fn shutdown(self) -> Result<()> {\n    self.inner.clear_cache();'
assert old in s
source.write_text(s.replace(old, '  pub fn shutdown(self) -> Result<()> {\n    println!("MEMORY_DIAGNOSTIC {:#?}", self.inner.statistics());\n    self.inner.clear_cache();'))
crate = Path('scripts/newcache-memory/vendor/rspack-turbo-persistence')
if not crate.exists():
    archive = Path('.spider/scratch/diagnostic-persistence.crate')
    subprocess.run(['curl', '-fL', '--retry', '3', 'https://crates.io/api/v1/crates/rspack-turbo-persistence/0.1.1/download', '-o', str(archive)], check=True)
    with tarfile.open(archive) as tar:
        tar.extractall('.spider/scratch', filter='data')
    crate = Path('.spider/scratch/rspack-turbo-persistence-0.1.1')
    s = manifest.read_text()
    s = s.replace('[workspace]\n', '[workspace]\nexclude = [".spider/scratch/rspack-turbo-persistence-0.1.1"]\n', 1)
    s += '\n[patch.crates-io]\nrspack-turbo-persistence = { path = ".spider/scratch/rspack-turbo-persistence-0.1.1" }\n'
    manifest.write_text(s)
block = crate / 'src/static_sorted_file.rs'
s = block.read_text()
s = s.replace('pub struct BlockCacheLifecycle;', '''pub struct BlockCacheLifecycle {
    #[cfg(feature = "stats")]
    pub inserts: Arc<AtomicU64>,
    #[cfg(feature = "stats")]
    pub evictions: Arc<AtomicU64>,
}
''')
s = s.replace('fn on_evict(&self, _state: &mut Self::RequestState, _key: (u32, u16), _val: ArcBytes) {}', '''fn on_evict(&self, _state: &mut Self::RequestState, _key: (u32, u16), _val: ArcBytes) {
        #[cfg(feature = "stats")]
        self.evictions.fetch_add(1, AtomicOrdering::Relaxed);
    }''')
# Use public lifecycle callbacks to count successful cache requests; guard insertion is counted explicitly.
s = s.replace('                let _ = guard.insert(block.clone());', '''                #[cfg(feature = "stats")]
                crate::db::DIAGNOSTIC_INSERTS.fetch_add(1, AtomicOrdering::Relaxed);
                let _ = guard.insert(block.clone());''')
# Evictions are aggregated globally, including key/value caches, with individual cache hits/weight in statistics.
s = s.replace('self.evictions.fetch_add(1, AtomicOrdering::Relaxed);', 'crate::db::DIAGNOSTIC_EVICTIONS.fetch_add(1, AtomicOrdering::Relaxed);')
block.write_text(s)
db = crate / 'src/db.rs'
s = db.read_text()
s = '#[cfg(feature = "stats")]\npub static DIAGNOSTIC_INSERTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);\n#[cfg(feature = "stats")]\npub static DIAGNOSTIC_EVICTIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);\n' + s
s = s.replace('    pub meta_files: usize,', '    pub block_insert_attempts: u64,\n    pub block_evictions: u64,\n    pub meta_files: usize,', 1)
s = s.replace('        Statistics {', '        Statistics {\n            block_insert_attempts: DIAGNOSTIC_INSERTS.load(Ordering::Relaxed),\n            block_evictions: DIAGNOSTIC_EVICTIONS.load(Ordering::Relaxed),', 1)
db.write_text(s)
print('Diagnostic-only TP stats and exact aggregate block insertion/eviction counters enabled')
