import assert from 'node:assert/strict';
import { parse } from 'acorn';
import vm from 'node:vm';

// Only the CSS filename hashes in miniCssF and the existing full hash vary.
export function runtimeCSS(source, chunks) {
  const fullHash = text => text.replace(/(__webpack_require__\.h = \(\) => \(")[0-9a-f]+("\))/g, '$1<FULL_HASH>$2');
  if (!source.includes('__webpack_require__.miniCssF =')) return { mappings: [], normalized: fullHash(source) };
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const functions = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
        node.left.object.name === '__webpack_require__' && node.left.property.name === 'miniCssF') functions.push(node.right);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
  const mappings = [];
  let normalized = source;
  for (const node of functions.reverse()) {
    const text = source.slice(node.start, node.end);
    const fn = vm.runInNewContext(`(${text})`, {}, { timeout: 1000 });
    const entries = chunks.map(({ id }) => {
      const filename = fn(id);
      assert.equal(typeof filename, 'string', 'miniCssF returns a CSS filename');
      return { chunkId: id, filename, logical: filename.replace(/\.[0-9a-f]{8}(?=\.css$)/i, '') };
    }).sort((a, b) => String(a.chunkId).localeCompare(String(b.chunkId)));
    mappings.unshift(entries);
    const scrubbed = text
      .replace(/(\.[0-9a-f]{8})(?=\.css["'])/gi, '.<CSS_HASH>')
      .replace(/(["'])[0-9a-f]{8}\1(?=\s*\+\s*["']\.css["'])/gi, '$1<CSS_HASH>$1');
    normalized = normalized.slice(0, node.start) + scrubbed + normalized.slice(node.end);
  }
  return { mappings, normalized: fullHash(normalized) };
}
