const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { threadId } = require('node:worker_threads');
const native = fs.realpathSync(process.env.RSPACK_BINDING);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (hash(native) !== process.env.EXPECTED_NATIVE_SHA) throw Error('Native checksum mismatch');
const original = process.dlopen;
process.dlopen = function(module, file, ...args) {
  if (path.basename(file).startsWith('rspack.') && file.endsWith('.node')) {
    if (fs.realpathSync(file) !== native || hash(file) !== process.env.EXPECTED_NATIVE_SHA) {
      throw Error('Unexpected native binding: ' + file);
    }
  }
  return original.call(this, module, file, ...args);
};
const binding = require(native);
binding.default = binding;
const Module = require('node:module');
const load = Module._load;
Module._load = function(request, parent, isMain) {
  return load.call(this, request === '@rspack/binding' ? native : request, parent, isMain);
};
const maps = fs.readFileSync('/proc/self/maps', 'utf8');
const mapped = [...new Set(maps.split('\n').filter(line => /rspack[^/]*\.node$/.test(line)).map(line => line.trim().split(/\s+/).at(-1)))];
if (mapped.length !== 1 || mapped[0] !== native) throw Error('Wrong mapped native binding: ' + JSON.stringify(mapped));
const record = { pid: process.pid, threadId, path: mapped[0], mapped, sha256: hash(mapped[0]), argv: process.argv };
if (process.env.NATIVE_IDENTITY_LOG) fs.appendFileSync(process.env.NATIVE_IDENTITY_LOG, JSON.stringify(record) + '\n');
if (process.env.MAPS_FILE) fs.writeFileSync(process.env.MAPS_FILE, maps);
console.log('VERIFIED_NATIVE ' + JSON.stringify(record));
