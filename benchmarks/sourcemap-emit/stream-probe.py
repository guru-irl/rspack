from pathlib import Path

def replace(path, old, new):
    p=Path(path); text=p.read_text(); assert old in text,(path,old); p.write_text(text.replace(old,new,1))
replace('crates/rspack_sources/src/lib.rs','  static MISS: AtomicUsize = AtomicUsize::new(0);', '''  static MISS: AtomicUsize = AtomicUsize::new(0);
  static REPLAY: AtomicUsize = AtomicUsize::new(0);
  pub fn active() -> bool { ACTIVE.load(Ordering::Relaxed) }
  pub fn replay(us: usize) { REPLAY.fetch_add(us, Ordering::Relaxed); }''')
replace('crates/rspack_sources/src/lib.rs','COMPOSE.store(0, Ordering::Relaxed);', 'REPLAY.store(0, Ordering::Relaxed); COMPOSE.store(0, Ordering::Relaxed);')
replace('crates/rspack_sources/src/lib.rs','"STUDY_CACHE compose {} hit {} miss {}", COMPOSE.load(Ordering::Relaxed), HIT.load(Ordering::Relaxed), MISS.load(Ordering::Relaxed)', '"STUDY_CACHE compose {} hit {} miss {} replay_us {}", COMPOSE.load(Ordering::Relaxed), HIT.load(Ordering::Relaxed), MISS.load(Ordering::Relaxed), REPLAY.load(Ordering::Relaxed)')
replace('crates/rspack_sources/src/cached_source.rs','''      Some(map) => {
        let source = self.get_or_init_source();''','''      Some(map) => {
        let study_start = crate::study_probe::active().then(std::time::Instant::now);
        let source = self.get_or_init_source();''')
replace('crates/rspack_sources/src/cached_source.rs','''        if let Some(map) = map {
          stream_chunks_of_source_map(''','''        let result = if let Some(map) = map {
          stream_chunks_of_source_map(''')
replace('crates/rspack_sources/src/cached_source.rs','''          stream_chunks_of_raw_source(source, options, on_chunk, on_source, on_name)
        }
      }
      None =>''','''          stream_chunks_of_raw_source(source, options, on_chunk, on_source, on_name)
        };
        if let Some(start) = study_start { crate::study_probe::replay(start.elapsed().as_micros() as usize); }
        result
      }
      None =>''')
