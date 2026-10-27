const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
function stripNamespace(file, platform = process.platform) {
  if (platform !== 'win32') return file;
  if (file.startsWith('\\\\?\\UNC\\')) return '\\\\' + file.slice(8);
  return file.startsWith('\\\\?\\') ? file.slice(4) : file;
}
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function fromObjects(objects, addon, expectedSha, platform = process.platform) {
  assert(Array.isArray(objects), 'loaded-object report required');
  assert.match(expectedSha, /^[a-f0-9]{64}$/);
  const selected = fs.realpathSync(stripNamespace(addon, platform));
  assert(fs.statSync(selected).isFile(), 'selected binding must be a regular file');
  assert.equal(hash(selected), expectedSha, 'artifact must match the arm-pinned binding hash');
  const loaded = new Set(), skipped = [];
  for (const original of objects) {
    if (typeof original !== 'string') continue;
    const file = stripNamespace(original, platform);
    if (!/\.node$/i.test(file)) continue;
    try {
      if (!fs.statSync(file).isFile()) { skipped.push({ original, reason: 'not-regular-file' }); continue; }
      loaded.add(fs.realpathSync(file));
    } catch (error) {
      if (!['EISDIR', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      skipped.push({ original, reason: error.code });
    }
  }
  const mapped = [...loaded];
  assert.equal(mapped.length, 1, JSON.stringify({ message: 'exactly one loaded native file required', mapped, skipped }));
  assert.equal(mapped[0], selected, 'the selected arm binding must be the loaded native file');
  assert.equal(hash(mapped[0]), expectedSha, 'loaded native file must match the arm-pinned hash');
  return { sha256: expectedSha, mapped, skipped };
}
function read(addon, expectedSha) {
  const objects = process.platform === 'linux'
    ? [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n').filter(line => /\.node(?:$| \(deleted\))/.test(line)).map(line => line.slice(line.indexOf('/'))))]
    : process.report.getReport().sharedObjects;
  return { ...fromObjects(objects, addon, expectedSha), report: process.platform === 'linux' ? '/proc/self/maps' : 'process.report.sharedObjects' };
}
module.exports = { stripNamespace, fromObjects, read };
if (require.main === module) {
  const [addon, expectedSha] = process.argv.slice(2);
  require(fs.realpathSync(stripNamespace(addon)));
  console.log(JSON.stringify({ kind: 'real-binding-identity-preflight', ...read(addon, expectedSha) }));
}
