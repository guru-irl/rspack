import fs from 'node:fs';
import path from 'node:path';

/** @type {import('@rspack/test-tools').THashCaseConfig} */
export default {
  validate(stats) {
    const [leftDelayed, rightDelayed] = stats.stats;
    const chunks = stats => Array.from(stats.compilation.chunks, chunk => ({
      id: chunk.id,
      hash: chunk.hash,
      contentHash: { ...chunk.contentHash },
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)));

    expect(chunks(leftDelayed)).toEqual(chunks(rightDelayed));
    expect(leftDelayed.hash).toBe(rightDelayed.hash);

    const assets = delayed => {
      const dir = path.resolve(import.meta.dirname, `dist/${delayed}`);
      return fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name))]);
    };
    expect(assets('left.js')).toEqual(assets('right.js'));
  },
};
