import path from 'node:path';

export const modules = 60701;
export const cells = ['K0', 'K1', 'K3', 'K5', 'SEG2', 'F25', 'F5', 'RFN', 'RRE'];
export const memoryCells = ['K0', 'K5', 'SEG2', 'F5', 'RFN', 'RRE'];
const counts = {K0: 0, K1: 1, K3: 3, K5: 5, SEG2: 5, F25: 5, F5: 5, RFN: 0, RRE: 0};
export const crossingModules = cell => cell === 'F25' ? 15175 : cell === 'F5' ? 3035 : counts[cell] ? modules : 0;
export function selected(cell, resource) {
  if (cell !== 'F25' && cell !== 'F5') return /\.[jt]s$/.test(resource);
  return coverage(cell).test(resource);
}
function coverage(cell) {
  const groups = cell === 'F25' ? '(?:[0-9]|1[0-9]|2[0-4])' : '[0-4]';
  const typed = Array.from({length: cell === 'F25' ? 150 : 30}, (_, i) => i).join('|');
  return new RegExp(`(?:[\\\\/]src[\\\\/]g${groups}[\\\\/](?:m[0-9]+|index)\\.js|[\\\\/]typed[\\\\/]t(?:${typed})\\.ts)$`);
}
export function rules(root, cell, diagnostic) {
  if (!cells.includes(cell)) throw new Error(`Unknown cell ${cell}`);
  const swc = {loader: 'builtin:swc-loader', options: {jsc: {parser: {syntax: 'typescript'}}}};
  const loader = id => ({loader: path.join(root, `loader-${id}${diagnostic ? '-diagnostic' : ''}.cjs`)});
  const loaders = Array.from({length: counts[cell]}, (_, i) => loader(i + 1));
  const use = cell === 'SEG2' ? [...loaders.slice(2), swc, ...loaders.slice(0, 2)] : [...loaders, swc];
  const result = [{test: /\.[jt]s$/, oneOf: [{test: cell === 'F25' || cell === 'F5' ? coverage(cell) : /\.[jt]s$/, use}, {use: [swc]}]}];
  for (let i = 0; i < 4 && (cell === 'RFN' || cell === 'RRE'); i++) {
    result.push(cell === 'RRE' ? {include: /\.[jt]s$/, use: []} : {
      include: diagnostic ? resource => { globalThis.ruleCalls.include++; return true; } : () => true,
      use: diagnostic ? data => { globalThis.ruleCalls.use++; return []; } : () => []
    });
  }
  return result;
}
export function verifyDiagnostic(cell) {
  const traces = globalThis.loaderTraces;
  const expectedModules = crossingModules(cell);
  if (traces.size !== expectedModules) throw new Error(`Crossing module count ${traces.size} != ${expectedModules}`);
  let jsCalls = 0, segmentEntries = 0;
  const layouts = {};
  for (const [resource, trace] of traces) {
    if (!selected(cell, resource)) throw new Error(`Unexpected selected resource ${resource}`);
    const ids = trace.map(item => item.id);
    const expectedIds = cell === 'SEG2' ? [2, 1, 5, 4, 3] : Array.from({length: counts[cell]}, (_, i) => counts[cell] - i);
    if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw new Error(`Wrong loader execution order ${resource}: ${ids}`);
    const signature = trace.map(item => item.layout).join('|');
    layouts[signature] = (layouts[signature] || 0) + 1;
    let previousIndex;
    let segments = 0;
    for (const item of trace) {
      jsCalls++;
      if (previousIndex === undefined || item.index !== previousIndex - 1) segments++;
      previousIndex = item.index;
      if (item.builtinCount !== 1) throw new Error('Expected exactly one builtin SWC loader');
    }
    if (segments !== (cell === 'SEG2' ? 2 : 1)) throw new Error('Wrong segment count');
    segmentEntries += segments;
  }
  const callbacks = globalThis.ruleCalls;
  const expectedCallbacks = cell === 'RFN' ? modules * 4 : 0;
  if (callbacks.include !== expectedCallbacks || callbacks.use !== expectedCallbacks) throw new Error(`Rule callback count mismatch: ${JSON.stringify(callbacks)}`);
  if (jsCalls !== expectedModules * counts[cell]) throw new Error('JS loader count mismatch');
  return {cell, moduleCount: modules, crossingModules: traces.size, jsCalls, segmentEntries, segmentsPerCrossingModule: expectedModules ? segmentEntries / expectedModules : 0, loadersPerCrossingModule: counts[cell], ruleCalls: callbacks, callbacksPerModule: (callbacks.include + callbacks.use) / modules, layouts};
}
