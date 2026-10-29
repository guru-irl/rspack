'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {fromObjects} = require('./loaded-binding-identity.cjs');
const root = path.resolve(process.argv[2]);
fs.mkdirSync(root, {recursive: true});
const file = path.join(root, 'identity-control.node');
const chunk = Buffer.alloc(1048576, 90), expected = crypto.createHash('sha256');
const fd = fs.openSync(file, 'w');
try {
 for (let n=0; n<64; n++) { fs.writeSync(fd, chunk); expected.update(chunk); }
 fs.writeSync(fd, chunk, 0, 17); expected.update(chunk.subarray(0, 17));
} finally { fs.closeSync(fd); }
const sha = expected.digest('hex');
function peak() {
 if (process.platform !== 'win32') return process.resourceUsage().maxRSS * 1024;
 const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).PeakWorkingSet64`], {encoding:'utf8'});
 assert.equal(result.status, 0, result.stderr);
 return Number(result.stdout.trim());
}
const before = peak();
const identity = fromObjects([file], file, sha);
assert.equal(identity.sha256, sha);
const increase = peak() - before;
console.log(JSON.stringify({kind:'identity-memory-control', fixtureBytes:64*1048576+17, peakIncreaseMiB:increase/1048576}));
assert(increase < 16*1048576, `identity hashing raised peak RSS by ${(increase/1048576).toFixed(2)} MiB, budget is 16 MiB`);
assert.throws(() => fromObjects([file], file, '0'.repeat(64)), /artifact must match/);
assert.throws(() => fromObjects([], file, sha), /exactly one loaded native file/);
console.log('Identity checksum, memory budget and rejection controls passed');
