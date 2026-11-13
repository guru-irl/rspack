const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { threadId } = require('node:worker_threads');
const expected = fs.realpathSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
require(path.join(path.dirname(expected), 'binding.js'));
const mapped = [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n')
  .map(line => line.match(/\s(\/.*\.node)$/)?.[1]).filter(Boolean))]
  .filter(file => path.basename(file).startsWith('rspack.'));
if (mapped.length !== 1 || fs.realpathSync(mapped[0]) !== expected) {
  throw new Error(`Wrong mapped binding: ${JSON.stringify(mapped)}, expected ${expected}`);
}
const hash = crypto.createHash('sha256').update(fs.readFileSync(mapped[0])).digest('hex');
if (hash !== process.env.EXPECTED_BINDING_SHA256) throw new Error(`Wrong binding hash: ${hash}`);
if (process.env.BINDING_PROOF_DIR) {
  fs.mkdirSync(process.env.BINDING_PROOF_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.BINDING_PROOF_DIR, `${process.pid}-${threadId}.json`), JSON.stringify({
    pid: process.pid, threadId, sourceSha: process.env.TASK_SOURCE_SHA, sourceTree: process.env.TASK_SOURCE_TREE,
    sha256: hash, binding: mapped[0], proof: 'maps'
  }));
}
console.error(`BINDING_PROOF pid=${process.pid} sha256=${hash} path=${mapped[0]}`);
