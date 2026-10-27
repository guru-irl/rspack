
fn main() {
  let root = std::path::PathBuf::from(std::env::args().nth(1).expect("fixture root"));
  let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
  runtime.block_on(async {
    let mut measurements = Vec::new();
    for (name, directory, alias) in [("leaf", false, false), ("leaf-alias", false, true), ("directory", true, false), ("directory-alias", true, true)] {
      let manager = paths::PathManager::default();
      let mut files: Vec<_> = (0..80000).map(|i| {
        let parent = if i < 1000 { root.join("removed") } else { root.join("other").join((i % 3000).to_string()) };
        InternedPath::from(parent.join(format!("file-{i}.txt")))
      }).collect();
      if alias {
        files.push(InternedPath::from(format!("{}/alias/./registered.txt", root.display())));
      }
      let contexts = (0..3000).map(|i| InternedPath::from(root.join("context").join(i.to_string()))).collect::<Vec<_>>();
      manager.update((files.into_iter(), std::iter::empty()), (contexts.into_iter(), std::iter::empty()), (std::iter::empty(), std::iter::empty())).await.expect("register");
      let deleted = InternedPath::from(if directory { root.join("removed") } else { root.join("removed/file-0.txt") });
      let mut times = Vec::new();
      for _ in 0..31 {
        manager.reset();
        let start = std::time::Instant::now();
        manager.request_deleted_scans(vec![deleted.clone()]);
        times.push(start.elapsed().as_nanos());
        manager.update((std::iter::empty(),std::iter::empty()),(std::iter::empty(),std::iter::empty()),(std::iter::empty(),std::iter::empty())).await.expect("apply recovery");
        assert_eq!(manager.access().files().1.len(), if directory { 1000 } else { 1 });
      }
      times.sort_unstable();
      measurements.push(format!("\"{name}Ns\":{},\"{name}RangeNs\":[{},{}]", times[15],times[0],times[30]));
    }
    println!("{{\"files\":80000,\"contexts\":3000,{}}}", measurements.join(","));
  });
}
