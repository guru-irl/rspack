import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const verify = require('./binding-guard.cjs');
require(path.join(process.env.ALIAS_SOURCE_ROOT, 'packages/rspack/dist/index.js'));
if (!verify()) throw Error('Expected test binding was not loaded and verified');
