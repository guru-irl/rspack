const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve('.hash-repro');
const packageRequire = createRequire(path.join(root, 'package/package.json'));
const { rspack } = packageRequire('@rspack/core');
(async () => {
  const casePath = path.resolve('tests/rspack-test/hashCases/static-url-dependency-order');
  const { default: config } = await import(pathToFileURL(path.join(casePath, 'rspack.config.mjs')));
  const { default: test } = await import(pathToFileURL(path.join(casePath, 'test.config.mjs')));
  const compiler = rspack(config);
  const stats = await new Promise((resolve, reject) => compiler.run((err, stats) => err ? reject(err) : resolve(stats)));
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
  await new Promise((resolve, reject) => compiler.close(err => err ? reject(err) : resolve()));
  global.expect = value => ({ toEqual: expected => assert.deepStrictEqual(value, expected), toBe: expected => assert.strictEqual(value, expected) });
  test.validate(stats);
})().catch(err => { console.error(err); process.exitCode = 1; });
