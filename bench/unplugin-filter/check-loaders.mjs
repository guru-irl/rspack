import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arm = process.argv[2];
const results = [];
for (const adapter of ['rspack', 'webpack']) {
  for (const kind of ['transform', 'load']) {
    const { default: loader } = await import(pathToFileURL(path.resolve('variants', arm, 'package', 'dist', adapter, 'loaders', `${kind}.mjs`)));
    let reads = 0;
    let handlerReads = 0;
    let calls = 0;
    let handler = () => { calls++; return kind === 'transform' ? 'first' : null; };
    const hook = {
      get handler() { handlerReads++; return handler; },
      get filter() { reads++; return { id: { include: ['**/*.ts'], exclude: ['**/excluded/**'] }, ...(kind === 'transform' ? { code: { include: 'allowed' } } : {}) }; }
    };
    const plugin = { [kind]: hook, __virtualModulePrefix: '__virtual__/' };
    const invoke = (resource, source) => new Promise((resolve, reject) => {
      const context = { query: { plugin }, resource, async() { return (error, code) => error ? reject(error) : resolve(code); } };
      loader.call(context, source, undefined).catch(reject);
    });
    assert.equal(await invoke('/fixture/a.ts', 'allowed'), kind === 'transform' ? 'first' : 'allowed');
    handler = () => { calls++; return 'second'; };
    assert.equal(await invoke('/fixture/b.ts', 'allowed'), 'second', 'handler replacement must stay visible');
    if (kind === 'transform') {
      assert.equal(await invoke('/fixture/excluded/a.ts', 'allowed'), 'allowed');
      assert.equal(await invoke('/fixture/a.ts', 'denied'), 'denied');
    }
    const expectedCalls = 2;
    assert.equal(calls, expectedCalls);
    assert.equal(handlerReads, kind === 'transform' ? 4 : 2, 'one fresh handler read per invocation');
    results.push({ adapter, kind, filter_reads: reads, handler_reads: handlerReads, calls });
  }
}
console.log(JSON.stringify(results));
for (const row of results) assert.equal(row.filter_reads, 1, `${row.adapter}/${row.kind}: filter must be normalized once per hook`);
console.log('All four loader caches and live-handler checks passed');
