import fs from 'node:fs';

const chains = [];
const seen = new WeakSet();
const originalSet = WeakMap.prototype.set;
WeakMap.prototype.set = function (key, value) {
  if (Array.isArray(key) && key.length && Array.isArray(value)
    && key.every(item => typeof item?.loader === 'string' && typeof item.type === 'string' && typeof item.cache === 'boolean')
    && value.every(item => typeof item?.path === 'string' && typeof item.query === 'string')
    && !seen.has(key)) {
    seen.add(key);
    chains.push({
      loaders: key.length,
      stringUtf8Bytes: key.reduce((sum, item) => sum + Buffer.byteLength(item.loader) + Buffer.byteLength(item.type), 0),
      requests: key.map(item => item.loader),
    });
  }
  return Reflect.apply(originalSet, this, [key, value]);
};
process.on('exit', code => {
  fs.writeFileSync(`${process.argv[3]}.chains.json`, JSON.stringify({exitCode: code, distinctChains: chains.length, loaderEntries: chains.reduce((sum, chain) => sum + chain.loaders, 0), stringUtf8Bytes: chains.reduce((sum, chain) => sum + chain.stringUtf8Bytes, 0), chains}, null, 2));
});
await import('../program-native/run.mjs');
