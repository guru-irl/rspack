const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { threadId } = require('node:worker_threads');
const root = path.resolve(process.env.ALIAS_SOURCE_ROOT);
const intended = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
if (!intended || !process.env.EXPECTED_BINDING_SHA256) throw Error('Missing binding pin');
const expectedPath = fs.realpathSync.native(intended);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(expectedPath)).digest('hex');
if (sha256 !== process.env.EXPECTED_BINDING_SHA256) throw Error('WRONG_BINDING_HASH ' + sha256);
delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
try {
  const req = createRequire(path.join(root, 'package.json'));
  const tool = createRequire(req.resolve('rstack/package.json'));
  req(path.join(path.dirname(req.resolve('rstack/package.json')), 'binding.cjs'));
  const build = createRequire(tool.resolve('@rsbuild/core/package.json'));
  const bundledCore = createRequire(build.resolve('@rspack/core/package.json'));
  bundledCore('@rspack/binding');
} finally {
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = intended;
}
let checked = false;
function verify() {
  const mapped = process.platform !== 'linux' || fs.readFileSync('/proc/self/maps', 'utf8')
    .split('\n').map(line => line.trim().split(/\s+/).slice(5).join(' ')).includes(expectedPath);
  if (!mapped) return false;
  if (!checked) fs.writeSync(2, 'BINDING_IDENTITY ' + JSON.stringify({
    pid: process.pid, threadId, binding: expectedPath, sha256,
    proof: process.platform === 'linux' ? 'maps' : 'dlopen'
  }) + '\n');
  checked = true;
  return true;
}
const original = process.dlopen;
process.dlopen = function(module, filename, ...args) {
  const result = original.call(this, module, filename, ...args);
  if (fs.realpathSync.native(filename) === expectedPath && !verify()) throw Error('Binding not mapped after dlopen');
  return result;
};
module.exports = () => checked && verify();
