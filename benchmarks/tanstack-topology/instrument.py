from pathlib import Path

path = Path('crates/rspack_core/src/compilation/build_chunk_graph/code_splitter.rs')
text = path.read_text()
start = text.index('  pub(crate) fn can_reuse_affected_module(')
end = text.index('  pub(crate) fn chunk_group_info(', start)
body = text[start:end]
body = body.replace('    let module_block =', '''    let probe = |reason: &str| {
      if module.as_str().contains("getServerFnById.js") {
        compilation.get_logger("rspack.topologyProbe").log(format!("reuse predicate: {reason}; module={module}"));
      }
    };
    let module_block =''', 1)
reasons = ['blocks differ', 'nested blocks', 'group options differ', 'missing cached block', 'connection count differs', 'target or active state differs']
for reason in reasons:
    before = 'return false;'
    position = body.index(before)
    body = body[:position] + f'probe("{reason}");\n      return /* logged */ false;' + body[position + len(before):]
body = body.replace('    for (runtime, block_modules) in &self.block_modules_runtime_map {', '''    if module.as_str().contains("getServerFnById.js") {
      let cached_roots = self.block_modules_runtime_map.values().filter(|map| map.contains_key(&module_block)).count();
      compilation.get_logger("rspack.topologyProbe").log(format!(
        "root evidence: cached_roots={cached_roots}; current_blocks={}; current_connection_blocks={}; prepared_connections={}; chunk_membership={}",
        current_blocks.len(), current_connections_by_block.len(), self.prepared_connection_map.contains_key(&module),
        compilation.build_chunk_graph_artifact.chunk_graph.get_number_of_module_chunks(module)
      ));
    }
    for (runtime, block_modules) in &self.block_modules_runtime_map {''', 1)
body = body.replace('    found_cached_root\n', '    if !found_cached_root { probe("no cached root"); }\n    found_cached_root\n')
path.write_text(text[:start] + body + text[end:])
print('Instrumented reuse predicate; return values unchanged')
