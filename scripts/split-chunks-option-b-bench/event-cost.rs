fn main() {
  let root = std::path::PathBuf::from(std::env::args().nth(1).expect("fixture root"));
  let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
  runtime.block_on(async {
    let mut measurements = Vec::new();
    let mut deletion_rows = Vec::new();
    for (name, directory, alias, many) in [
      ("leaf", false, false, false), ("leaf-alias", false, true, false),
      ("directory", true, false, false), ("directory-alias", true, true, false),
      ("leaf-many", false, false, true), ("leaf-many-alias", false, true, true),
      ("directory-many", true, false, true), ("directory-many-alias", true, true, true),
    ] {
      let manager = paths::PathManager::default();
      let mut files: Vec<_> = (0..80000).map(|i| {
        let parent = if many { root.join("many").join((i % 1200).to_string()) }
          else if i < 1000 { root.join("removed") }
          else { root.join("other").join((i % 3000).to_string()) };
        InternedPath::from(parent.join(format!("file-{i}.txt")))
      }).collect();
      let deleted = if many {
        (0..600).map(|i| InternedPath::from(if directory { root.join("many").join(i.to_string()) } else { root.join("many").join(i.to_string()).join(format!("file-{i}.txt")) })).collect::<Vec<_>>()
      } else {
        vec![InternedPath::from(if directory { root.join("removed") } else { root.join("removed/file-0.txt") })]
      };
      if alias { files.push(InternedPath::from(std::path::PathBuf::from(format!("{}/alias/./registered.txt", root.display())))); }
      let contexts = (0..3000).map(|i| InternedPath::from(root.join("method-context").join(i.to_string()))).collect::<Vec<_>>();
      manager.update((files.into_iter(), std::iter::empty()), (contexts.into_iter(), std::iter::empty()), (std::iter::empty(), std::iter::empty())).await.expect("register");
      let expected = if many { if directory { (0..80000).filter(|i| i % 1200 < 600).count() } else { 600 } } else if directory { 1000 } else { 1 };
      let mut times = Vec::new();
      for _ in 0..31 {
        manager.reset();
        let start = std::time::Instant::now();
        manager.request_deleted_scans(deleted.clone());
        times.push(start.elapsed().as_nanos());
        manager.update((std::iter::empty(),std::iter::empty()),(std::iter::empty(),std::iter::empty()),(std::iter::empty(),std::iter::empty())).await.expect("apply recovery");
        assert_eq!(manager.access().files().1.len(), expected, "{name} recovered registrations");
      }
      times.sort_unstable();
      measurements.push(format!("\"{name}Ns\":{},\"{name}RangeNs\":[{},{}]", times[15],times[0],times[30]));
      deletion_rows.push(format!("{{\"name\":\"{name}\",\"roots\":{},\"matchedFiles\":{expected},\"aliasRegistrations\":{}}}",deleted.len(),usize::from(alias)));
    }
    let manager = paths::PathManager::default();
    let files: Vec<_> = (0..80000).map(|i| InternedPath::from(root.join("contexts").join((i % 3000).to_string()).join(format!("file-{i}.txt")))).collect();
    let dirty = files[..600].to_vec();
    let contexts = (0..3000).map(|i| InternedPath::from(root.join("contexts").join(i.to_string()))).collect::<Vec<_>>();
    manager.update((files.into_iter(),std::iter::empty()),(contexts.into_iter(),std::iter::empty()),(std::iter::empty(),std::iter::empty())).await.expect("invalidation registration");
    let engine = analyzer::RecommendedAnalyzer::default();
    let expected: rspack_util::fx_hash::FxHashSet<_> = analyzer::Analyzer::analyze(&engine,manager.access()).into_iter().collect();
    let mut invalidation_times = Vec::new();
    for iteration in 0..31 {
      for file in &dirty { std::fs::write(file,format!("method-{iteration}")).expect("rewrite actual fixture file"); }
      manager.reset();
      manager.update((std::iter::empty(),std::iter::empty()),(std::iter::empty(),std::iter::empty()),(std::iter::empty(),std::iter::empty())).await.expect("retain registrations");
      let start = std::time::Instant::now();
      for file in &dirty { analyzer::Analyzer::invalidate_path(&engine,file); }
      let actual = analyzer::Analyzer::analyze(&engine,manager.access());
      invalidation_times.push(start.elapsed().as_nanos());
      assert!(actual.into_iter().collect::<rspack_util::fx_hash::FxHashSet<_>>()==expected,"invalidation changed watch coverage");
    }
    invalidation_times.sort_unstable();
    println!("{{\"files\":80000,\"contexts\":3000,{},\"deletionMethods\":[{}],\"rewrite600AnalyzeNs\":{},\"rewrite600AnalyzeRangeNs\":[{},{}],\"invalidationRoots\":600,\"watchPatternParity\":true}}",measurements.join(","),deletion_rows.join(","),invalidation_times[15],invalidation_times[0],invalidation_times[30]);
  });
}
