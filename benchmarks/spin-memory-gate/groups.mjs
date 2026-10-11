export function groupsFor(counts) {
  const callback = true;
  const track = (selector, body) => (...args) => { counts[selector]++; return body(...args); };
  const groups = { defaultVendors: false };
  const priorities = Array.from({ length: 48 }, (_, i) => 3 + i * 2);
  for (let i = 0; i < 112; i++) {
    groups[`native${i}`] = {
      test: new RegExp(`[\\\\/]packages[\\\\/]p${String(i).padStart(3, '0')}[\\\\/]`),
      priority: priorities[i % 48], minSize: 1e12, minChunks: 2,
      chunks: 'all', reuseExistingChunk: true,
    };
  }
  const absent = /[\\/]packages[\\/]p999[\\/]/;
  for (let i = 0; i < 6; i++) {
    groups[`function${i}`] = {
      priority: 95, chunks: 'all', minChunks: 2, minSize: 1e12,
      test: callback ? track('test', (m, info) => {
        const hasChunks = i !== 0 || info.chunkGraph.getModuleChunks(m).length > 0;
        return hasChunks && absent.test(m.resource || '');
      }) : absent,
    };
  }
  groups.largeName = {
    priority: 93, test: /[\\/]packages[\\/]/, chunks: 'all', minChunks: 2, minSize: 1e12,
    name: callback ? track('name', () => 'package') : 'package',
  };
  groups.rareName = {
    priority: 93, test: /[\\/]m0000[01]\.js$/, chunks: 'all', minChunks: 2, minSize: 1e12,
    name: callback ? track('name', () => 'rare') : 'rare',
  };
  groups.default = {
    priority: -20, minChunks: 2, minSize: 20000, reuseExistingChunk: true,
    // Unnamed async chunks must pass. No generated chunk is named 'never'.
    chunks: callback ? track('chunks', c => c.name !== 'never') : 'all',
  };
  return groups;
}
