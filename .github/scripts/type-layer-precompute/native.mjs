import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function verifyNative() {
  const expected = fs.realpathSync.native(process.env.RSPACK_BINDING);
  createRequire(import.meta.url)(expected);
  const candidates = process.platform === 'linux'
    ? fs.readFileSync('/proc/self/maps', 'utf8').split('\n').map(line => line.match(/\s(\/.*)$/)?.[1]).filter(Boolean)
    : process.report.getReport().sharedObjects;
  if (process.platform === 'win32') console.error('Mapped Windows paths', JSON.stringify(candidates.filter(file => file.endsWith('.node'))));
  const mapped = [...new Set(candidates.filter(file => path.basename(file).startsWith('rspack.') && file.endsWith('.node')).map(file => fs.realpathSync.native(file)))];
  assert.deepEqual(mapped, [expected], 'Exactly the requested Rspack binding must be mapped');
  const sha256 = hash(mapped[0]);
  assert.equal(sha256, process.env.EXPECTED_NATIVE_SHA, 'Mapped binding checksum mismatch');
  return { file: path.basename(mapped[0]), sha256, source: process.platform === 'linux' ? '/proc/self/maps' : 'process.report.sharedObjects' };
}
