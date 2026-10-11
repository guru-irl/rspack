from pathlib import Path

def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    assert text.count(old) >= count, (path, old)
    p.write_text(text.replace(old, new, count))

replace('crates/rspack_sources/src/source.rs', '#[serde(rename = "sourcesContent", skip_serializing_if = "is_all_empty")]', '#[serde(rename = "sourcesContent", skip_serializing_if = "is_all_empty", serialize_with = "study_content")]')
replace('crates/rspack_sources/src/source.rs', 'impl<\'a> SourceMapFields<\'a> {', '''fn study_content<S: Serializer>(content: &[Cow<'_, str>], serializer: S) -> std::result::Result<S::Ok, S::Error> {
  let start = std::time::Instant::now();
  let result = content.serialize(serializer);
  if content.len() > 1000 && std::env::var_os("STUDY_PROBE").is_some() {
    eprintln!("STUDY_METRIC content_json_us {}", start.elapsed().as_micros());
  }
  result
}

impl<'a> SourceMapFields<'a> {''')
replace('crates/rspack_sources/src/source.rs', 'let mut buffer = Vec::with_capacity(self.json_size_hint());', 'let study_start = std::time::Instant::now();\n    let mut buffer = Vec::with_capacity(self.json_size_hint());')
replace('crates/rspack_sources/src/source.rs', 'simd_json::to_writer(&mut buffer, self).unwrap();', '''simd_json::to_writer(&mut buffer, self).unwrap();
    if buffer.len() > 10_000_000 && std::env::var_os("STUDY_PROBE").is_some() {
      eprintln!("STUDY_METRIC total_json_us {} bytes {} capacity {}", study_start.elapsed().as_micros(), buffer.len(), buffer.capacity());
    }''')
replace('crates/rspack_plugin_devtool/src/source_map_dev_tool_plugin.rs', 'let source_map = {\n                let object_pool', 'let study_map_start = std::time::Instant::now();\n              let source_map = {\n                let object_pool', 2)
replace('crates/rspack_plugin_devtool/src/source_map_dev_tool_plugin.rs', 'let source_references = compute_source_references(compilation, &source_map);', '''if source.size() > 10_000_000 && std::env::var_os("STUDY_PROBE").is_some() {
                eprintln!("STUDY_METRIC stitch_map_us {}", study_map_start.elapsed().as_micros());
              }
              let source_references = compute_source_references(compilation, &source_map);''', 2)
replace('crates/rspack_plugin_devtool/src/source_map_dev_tool_plugin.rs', 'let raw_source = match source.source() {', 'let study_flat_start = std::time::Instant::now();\n              let raw_source = match source.source() {', 2)
replace('crates/rspack_plugin_devtool/src/source_map_dev_tool_plugin.rs', 'let task = SourceMapTask {', '''if raw_source.size() > 10_000_000 && std::env::var_os("STUDY_PROBE").is_some() {
                eprintln!("STUDY_METRIC flatten_us {}", study_flat_start.elapsed().as_micros());
              }
              let task = SourceMapTask {''', 2)
replace('crates/rspack_binding_api/src/fs_node/write.rs', 'let data = data.to_vec();', '''let study_start = std::time::Instant::now();
    let data = data.to_vec();
    if data.len() > 10_000_000 && std::env::var_os("STUDY_PROBE").is_some() {
      eprintln!("STUDY_METRIC write_copy_us {} bytes {}", study_start.elapsed().as_micros(), data.len());
    }''')
replace('crates/rspack_core/src/compiler/mod.rs', 'let content = source.buffer();', '''let study_start = std::time::Instant::now();
      let content = source.buffer();
      if content.len() > 10_000_000 && std::env::var_os("STUDY_PROBE").is_some() {
        eprintln!("STUDY_METRIC emit_flat_us {} bytes {}", study_start.elapsed().as_micros(), content.len());
      }''')
replace('crates/rspack_core/src/compiler/mod.rs', 'Ok(c) => content != c,', '''Ok(c) => {
            let study_start = std::time::Instant::now();
            let differs = content != c;
            if content.len() > 10_000_000 && std::env::var_os("STUDY_PROBE").is_some() {
              eprintln!("STUDY_METRIC compare_us {}", study_start.elapsed().as_micros());
            }
            differs
          },''')
