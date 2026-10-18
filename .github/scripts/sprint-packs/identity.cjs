const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const selected = fs.realpathSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (hash(selected) !== process.env.EXPECTED_NATIVE_SHA) throw Error('Native checksum mismatch');
const original = process.dlopen;
process.dlopen = function(module, file, ...rest) {
  if (file.endsWith('.node')) {
    if (fs.realpathSync(file) !== selected || hash(file) !== process.env.EXPECTED_NATIVE_SHA) throw Error('Unexpected native module: ' + file);
  }
  return original.call(this, module, file, ...rest);
};
require(selected);
const maps = fs.readFileSync('/proc/self/maps', 'utf8');
const mapped = [...new Set(maps.split('\n').filter(line => /\.node(?:\s|$)/.test(line)).map(line => line.slice(line.indexOf('/'))))];
if (mapped.length !== 1 || mapped[0] !== selected) throw Error('Unexpected native process maps: ' + JSON.stringify(mapped));
const identity = {pid: process.pid, path: selected, sha256: hash(selected), mapped};
fs.writeFileSync(process.env.MAPS_FILE, maps);
fs.writeFileSync(process.env.IDENTITY_FILE, JSON.stringify(identity, null, 2) + '\n');
console.log('VERIFIED_NATIVE ' + JSON.stringify(identity));
