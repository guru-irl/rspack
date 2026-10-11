from pathlib import Path

def replace(path, old, new):
    p=Path(path); text=p.read_text(); assert old in text,(path,old); p.write_text(text.replace(old,new,1))
replace('crates/rspack_sources/src/helpers.rs', '''fn stream_chunks_of_source_map_lines_final<'chunk, 'source>(
  source: TextSpan<'chunk>,
  source_map: &'source SourceMapFields<'_>,
  on_chunk: OnChunk,
  on_source: OnSource<'_, 'source>,
  _on_name: OnName,
) -> GeneratedInfo {
  let result = get_generated_source_info(source);
  if result.generated_line == 1 && result.generated_column == 0 {''', '''fn stream_chunks_of_source_map_lines_final<'chunk, 'source>(
  source: TextSpan<'chunk>,
  source_map: &'source SourceMapFields<'_>,
  on_chunk: OnChunk,
  on_source: OnSource<'_, 'source>,
  _on_name: OnName,
) -> GeneratedInfo {
  stream_chunks_of_source_map_lines_final_with_info(get_generated_source_info(source), source_map, on_chunk, on_source)
}

pub(crate) fn stream_chunks_of_source_map_lines_final_with_info<'source>(
  result: GeneratedInfo,
  source_map: &'source SourceMapFields<'_>,
  on_chunk: OnChunk,
  on_source: OnSource<'_, 'source>,
) -> GeneratedInfo {
  if result.generated_line == 1 && result.generated_column == 0 {''')
replace('crates/rspack_sources/src/cached_source.rs','stream_chunks_of_raw_source, stream_chunks_of_source_map,', 'stream_chunks_of_raw_source, stream_chunks_of_source_map, stream_chunks_of_source_map_lines_final_with_info,')
replace('crates/rspack_sources/src/cached_source.rs','''      Some(map) => {
        let study_start''','''      Some(map) => {
        if !options.columns && options.final_source {
          if let Some(map) = map {
            let mut generated_line = 1u32;
            let mut generated_column = 0u32;
            self.cache_source.rope(&mut |piece| {
              for line in crate::helpers::split_into_lines(piece) {
                if line.ends_with('\\n') {
                  generated_line += 1; generated_column = 0;
                } else {
                  generated_column += crate::helpers::utf16_len(line) as u32;
                }
              }
            });
            return stream_chunks_of_source_map_lines_final_with_info(
              GeneratedInfo { generated_line, generated_column }, map.fields(), on_chunk, on_source,
            );
          }
        }
        let study_start''')
