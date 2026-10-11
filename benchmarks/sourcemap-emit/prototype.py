from pathlib import Path
import sys

def replace(path, old, new):
    p = Path(path); text = p.read_text(); assert old in text, (path, old); p.write_text(text.replace(old, new, 1))

if sys.argv[1] == 'buffer':
    replace('crates/rspack_binding_api/src/compilation/mod.rs', '  #[napi(getter)]\n  pub fn modules(&self)', '''  #[napi]
  pub fn get_asset_buffer(&self, name: String) -> Result<Option<Buffer>> {
    let compilation = self.as_ref()?;
    Ok(compilation.assets().get(&name).and_then(|asset| asset.source.as_ref())
      .map(|source| Buffer::from(source.buffer().into_owned())))
  }

  #[napi(getter)]
  pub fn modules(&self)''')
    replace('packages/rspack/src/Compilation.ts', '  __internal__getAssetSource(filename: string): Source | void {', '''  __internal__getAssetBuffer(filename: string): Buffer | undefined {
    return this.#inner.getAssetBuffer(filename) ?? undefined;
  }

  __internal__getAssetSource(filename: string): Source | void {''')
    replace('packages/rspack/src/taps/compiler.ts', 'return (content ??= this.source.buffer());', '''if (content === undefined) {
                content = source !== undefined ? source.buffer() : getCompiler()
                  .__internal__get_compilation()!.__internal__getAssetBuffer(filename);
                if (content === undefined) throw new Error(`Asset ${filename} not found`);
              }
              return content;''')
elif sys.argv[1] == 'json':
    # Temporary rayon dependency uses existing workspace version; no new cache fields.
    replace('crates/rspack_sources/Cargo.toml', '[dependencies]', '[dependencies]\nrayon = { workspace = true }')
    replace('crates/rspack_sources/src/source.rs', '  pub fn to_json(&self) -> String {', '''  pub fn to_json(&self) -> String {
    if self.fields.sources_content.iter().map(|c| c.len()).sum::<usize>() > 8_000_000 {
      return self.study_parallel_json();
    }
    self.study_serial_json()
  }

  fn study_parallel_json(&self) -> String {
    use rayon::prelude::*;
    use std::io::Write;
    struct Counter(usize);
    impl Write for Counter {
      fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { self.0 += bytes.len(); Ok(bytes.len()) }
      fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    // Count using the same serializer, so escaping and Unicode remain byte-identical.
    // Store only one usize per module, not escaped source-sized intermediate strings.
    let start = std::time::Instant::now();
    let lengths: Vec<usize> = self.fields.sources_content.par_iter().map(|c| {
      let mut counter = Counter(0); simd_json::to_writer(&mut counter, c).unwrap(); counter.0
    }).collect();
    let count_us = start.elapsed().as_micros();
    let mut fields = self.fields.as_borrowed();
    fields.sources_content = Cow::Borrowed(&[]);
    // Canonical small fields, preserving serializer field order. Insert sourcesContent before names.
    let header = simd_json::to_vec(&fields).unwrap();
    let marker = b",\\\"names\\\":";
    let split = header.windows(marker.len()).position(|s| s == marker).unwrap();
    let prefix = b",\\\"sourcesContent\\\":[";
    let content_size = lengths.iter().sum::<usize>() + lengths.len().saturating_sub(1);
    let mut output = Vec::with_capacity(header.len() + prefix.len() + content_size + 1);
    output.extend_from_slice(&header[..split]); output.extend_from_slice(prefix);
    let content_start = output.len();
    output.resize(content_start + content_size, 0);
    // Safe recursive splitting creates disjoint mutable output slices, with no per-string buffers.
    fn fill(contents: &[Cow<'_, str>], lengths: &[usize], out: &mut [u8]) {
      if contents.len() <= 64 {
        let mut rest = out;
        for (index, (c, len)) in contents.iter().zip(lengths).enumerate() {
          let (piece, tail) = rest.split_at_mut(*len);
          let mut writer = piece; simd_json::to_writer(&mut writer, c).unwrap(); assert!(writer.is_empty());
          rest = tail;
          if index + 1 != contents.len() { rest[0] = b','; rest = &mut rest[1..]; }
        }
        assert!(rest.is_empty());
      } else {
        let mid = contents.len() / 2;
        let offset = lengths[..mid].iter().sum::<usize>() + mid - 1;
        let (left, tail) = out.split_at_mut(offset);
        let (comma, right) = tail.split_at_mut(1); comma[0] = b',';
        rayon::join(|| fill(&contents[..mid], &lengths[..mid], left), || fill(&contents[mid..], &lengths[mid..], right));
      }
    }
    let fill_start = std::time::Instant::now();
    fill(&self.fields.sources_content, &lengths, &mut output[content_start..]);
    let fill_us = fill_start.elapsed().as_micros();
    output.push(b']'); output.extend_from_slice(&header[split..]);
    if std::env::var_os("STUDY_PROBE").is_some() {
      eprintln!("STUDY_METRIC parallel_json_count_us {} fill_us {} total_us {}", count_us, fill_us, start.elapsed().as_micros());
    }
    // All slices were filled by the canonical UTF-8 JSON serializer.
    String::from_utf8(output).unwrap()
  }

  fn study_serial_json(&self) -> String {''')
else: raise SystemExit('unknown prototype')
