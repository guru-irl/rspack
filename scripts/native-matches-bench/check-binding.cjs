const fs = require('node:fs');
const crypto = require('node:crypto');
process.on('exit', () => {
  const expected = fs.realpathSync(process.env.RSPACK_BINDING);
  const loaded = Object.keys(require.cache).filter(p => p.endsWith('.node')).map(p => fs.realpathSync(p));
  if (loaded.length !== 1 || loaded[0] !== expected) {
    console.error('Native binding selection mismatch', { expected, loaded });
    process.exitCode = 1;
  } else {
    console.error('Verified native SHA256:', crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex'));
  }
});
