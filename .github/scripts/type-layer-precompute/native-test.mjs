import assert from 'node:assert/strict';
import { hash, verifyNative } from './native.mjs';

process.env.EXPECTED_NATIVE_SHA = hash(process.env.RSPACK_BINDING);
const good = verifyNative();
process.env.EXPECTED_NATIVE_SHA = '0'.repeat(64);
assert.throws(() => verifyNative(), /Mapped binding checksum mismatch/);
process.env.EXPECTED_NATIVE_SHA = good.sha256;
assert.equal(verifyNative().sha256, good.sha256);
console.log('Native identity accepted the mapped checksum and rejected a wrong checksum');
