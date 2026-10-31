'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
require('../cost-phases/instrument.cjs');
function patch(file,old,next){let text=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');assert.equal(text.split(old).length,2,old);fs.writeFileSync(file,text.replace(old,next));}
const base='source/crates/rspack_watcher/src/';
const names=['SCAN','PROCESS','INVALIDATE','CALLBACK','TIMEINFO'];
let extra='\n';
for(const name of names)for(const suffix of ['COUNT','NS'])extra+=`pub(crate) static COST_${name}_${suffix}: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);\n`;
extra+=`pub(crate) static COST_SCAN_DIRS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(crate) struct CostTimer { start: std::time::Instant, count: &'static std::sync::atomic::AtomicU64, ns: &'static std::sync::atomic::AtomicU64 }
impl CostTimer { pub(crate) fn new(count: &'static std::sync::atomic::AtomicU64, ns: &'static std::sync::atomic::AtomicU64) -> Self { Self {start: std::time::Instant::now(),count,ns} } }
impl Drop for CostTimer { fn drop(&mut self) { self.count.fetch_add(1,std::sync::atomic::Ordering::Relaxed);self.ns.fetch_add(self.start.elapsed().as_nanos() as u64,std::sync::atomic::Ordering::Relaxed); } }
pub(crate) fn cost_snapshot(stage: &str) {
 use std::sync::atomic::Ordering::Relaxed;
 eprintln!("WATCH_EXTRA stage={} ${names.map(n=>`${n.toLowerCase()}Count={} ${n.toLowerCase()}Ns={}`).join(' ')} scanDirs={}",stage,${names.flatMap(n=>[`COST_${n}_COUNT.load(Relaxed)`,`COST_${n}_NS.load(Relaxed)`]).join(',')},COST_SCAN_DIRS.load(Relaxed));
}
`;
fs.appendFileSync(base+'paths.rs',extra);
const timer=name=>`let _cost_timer = crate::paths::CostTimer::new(&crate::paths::COST_${name}_COUNT,&crate::paths::COST_${name}_NS);`;
patch(base+'paths.rs','  ) -> Vec<InternedPath> {\n    let mut changed = Vec::new();','  ) -> Vec<InternedPath> {\n    '+timer('SCAN')+'\n    let mut changed = Vec::new();');
patch(base+'paths.rs','    while let Some((dir, mut ancestry, observed)) = pending.pop() {','    while let Some((dir, mut ancestry, observed)) = pending.pop() {\n      COST_SCAN_DIRS.fetch_add(1,std::sync::atomic::Ordering::Relaxed);');
patch(base+'paths.rs','  pub fn collect_time_info_entries(&self) -> (TimeInfoEntries, TimeInfoEntries) {','  pub fn collect_time_info_entries(&self) -> (TimeInfoEntries, TimeInfoEntries) {\n    '+timer('TIMEINFO'));
patch(base+'trigger.rs','  async fn process(&self, path: &InternedPath, kind: FsEventKind, origin: Origin) {','  async fn process(&self, path: &InternedPath, kind: FsEventKind, origin: Origin) {\n    '+timer('PROCESS'));
patch(base+'analyzer/directories.rs','  fn invalidate_path(&self, path: &InternedPath) {','  fn invalidate_path(&self, path: &InternedPath) {\n    '+timer('INVALIDATE'));
patch(base+'disk_watcher.rs','        Ok(event) => {','        Ok(event) => {\n          '+timer('CALLBACK'));
patch(base+'disk_watcher.rs','    self.analyzer_patterns = patterns.collect();','    crate::paths::cost_snapshot("watch");\n    self.analyzer_patterns = patterns.collect();');
patch(base+'disk_watcher.rs','  pub fn close(&mut self) {','  pub fn close(&mut self) {\n    crate::paths::cost_snapshot("close");');
console.log('EVENT_COST_PATCH_APPLIED');
