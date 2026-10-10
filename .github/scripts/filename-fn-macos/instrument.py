from pathlib import Path
import sys
w=Path(sys.argv[1]);arm=sys.argv[2]
f=w/'crates/rspack_core/src/compilation/pass.rs';s=f.read_text()
start='  let start = logger.time(pass.name());\n';assert start in s
s=s.replace(start,start+'''  let filename_measure = std::env::var_os("FILENAME_MEASURE").is_some()
    && matches!(pass.name(), "hashing" | "create chunk assets");
  if filename_measure {
    eprintln!("FILENAME_PASS {} start {}", pass.name(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_micros());
  }
''')
end='  logger.time_end(start);';assert end in s
s=s.replace(end,'''  if filename_measure {
    eprintln!("FILENAME_PASS {} end {}", pass.name(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_micros());
  }
'''+end);f.write_text(s)
if arm=='R':
 f=w/'packages/rspack/src/config/adapter.ts';s=f.read_text()
 for i,name in enumerate(['filename','chunkFilename','cssFilename','cssChunkFilename']):
  a=f'getRawFilenameBatch(output.{name})';assert a in s;s=s.replace(a,f'getRawFilenameBatch(output.{name}, {i})')
 s=s.replace("  filename: Output['filename'],\n): RawOutputOptions['filenameBatch']", "  filename: Output['filename'],\n  field: number,\n): RawOutputOptions['filenameBatch']")
 a='  return paths => {\n';assert a in s
 s=s.replace(a,a+"    const record = (globalThis as Record<symbol, ((field: number, count: number, stage: number) => void) | undefined>)[Symbol.for('filename-fn-bench')];\n    record?.(field, paths.length, 0);\n",1);f.write_text(s)
