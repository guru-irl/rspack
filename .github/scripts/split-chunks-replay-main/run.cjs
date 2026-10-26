const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { hash, memory } = require('./native-identity.cjs');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

if (process.argv.includes('--self-test')) {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([5, 1]), 3);
  assert.equal(median([1, 1, 9, 3, 2]), 2);
  console.log('median controls passed');
  process.exit(0);
}

assert.equal(process.arch, process.env.EXPECTED_ARCH);
const root = process.cwd();
const resultRoot = path.join(root, 'bench-data/results');
const fixture = path.join(root, 'bench-data/fixture');
const native = fs.realpathSync(process.env.RSPACK_BINDING);
const sha256 = hash(native);
const originalFile = path.join(fixture, 'src/g0/m0.js');
const originalSha = hash(originalFile);
const capability = memory();
fs.mkdirSync(resultRoot, { recursive: true });
const order = [
  ['OFF', 'ON'],
  ['ON', 'OFF'],
  ['OFF', 'ON'],
];
const runs = [];
const paired = [];
for (const [index, arms] of order.entries()) {
  const pair = {};
  for (const arm of arms) {
    assert.equal(
      hash(originalFile),
      originalSha,
      'Each process must start from the same fixture',
    );
    assert(!fs.existsSync(path.join(fixture, 'src/g0/added-module.js')));
    const resultDir = path.join(resultRoot, `pair-${index + 1}`, arm);
    fs.mkdirSync(resultDir, { recursive: true });
    const env = {
      ...process.env,
      EXPECTED_NATIVE_SHA: sha256,
      CORE_ENTRY: path.join(root, 'packages/rspack/dist/index.js'),
      FIXTURE_ROOT: fixture,
      RESULT_DIR: resultDir,
      COPY_OUTPUTS: '0',
      MEASURE_CHUNK_DIAGNOSTICS: '0',
      MEASURE_HMR: '0',
      NODE_OPTIONS: '--max-old-space-size=8192 --stack-trace-limit=100',
      NATIVE_IDENTITY_LOG: path.join(resultDir, 'native.jsonl'),
    };
    delete env.MEASURE_COLD_EDIT;
    if (arm === 'ON') env.RSPACK_SPLIT_CHUNKS_REPLAY = '1';
    else delete env.RSPACK_SPLIT_CHUNKS_REPLAY;
    const log = fs.openSync(path.join(resultDir, 'watch.log'), 'w');
    let child;
    try {
      child = spawnSync(
        process.execPath,
        [
          '--expose-gc',
          '--require',
          path.join(__dirname, 'preload.cjs'),
          path.join(__dirname, 'measure.cjs'),
        ],
        {
          cwd: root,
          env,
          stdio: ['ignore', log, log],
          timeout: 20 * 60 * 1000,
        },
      );
    } finally {
      fs.closeSync(log);
    }
    assert(!child.error, child.error?.message);
    assert.equal(child.signal, null);
    assert.equal(
      child.status,
      0,
      `pair ${index + 1} ${arm} failed; see watch.log`,
    );
    const data = JSON.parse(
      fs.readFileSync(path.join(resultDir, 'builds.json'), 'utf8'),
    );
    assert.equal(data.nativeIdentity.sha256, sha256);
    assert.equal(data.rows.length, 7);
    const content = data.rows.filter((row) => row.step.startsWith('content-'));
    assert.equal(content.length, 5);
    const replayHits = content.filter((row) =>
      row.replay?.startsWith('replay: replayed '),
    ).length;
    assert.equal(replayHits, arm === 'ON' ? 5 : 0);
    const peakMiB = data.finalMemory.peakRssKiB / 1024;
    const steadyMiB = median(content.map((row) => row.steady.rssKiB)) / 1024;
    const coldMiB = data.rows[0].steady.rssKiB / 1024;
    const run = {
      pair: index + 1,
      arm,
      peakMiB,
      steadyMiB,
      coldMiB,
      hashes: data.rows.map((row) => row.statsHash),
      replayHits,
      nativeSha256: sha256,
      peakSource: data.finalMemory.peakSource,
    };
    assert(
      run.hashes.every(
        (value) => typeof value === 'string' && value.length > 0,
      ),
    );
    runs.push(run);
    pair[arm] = run;
    console.log(JSON.stringify(run));
  }
  assert.deepEqual(
    pair.OFF.hashes,
    pair.ON.hashes,
    `Full hashes differ in pair ${index + 1}`,
  );
  paired.push({
    pair: index + 1,
    peakDeltaMiB: pair.ON.peakMiB - pair.OFF.peakMiB,
    steadyDeltaMiB: pair.ON.steadyMiB - pair.OFF.steadyMiB,
    coldDeltaMiB: pair.ON.coldMiB - pair.OFF.coldMiB,
  });
}
const medians = {};
for (const arm of ['OFF', 'ON']) {
  const values = runs.filter((run) => run.arm === arm);
  medians[arm] = Object.fromEntries(
    ['peakMiB', 'steadyMiB', 'coldMiB'].map((key) => [
      key,
      median(values.map((run) => run[key])),
    ]),
  );
}
const summary = {
  sourceHead: process.env.SOURCE_HEAD,
  sourceRun: process.env.SOURCE_RUN,
  benchmarkHead: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cpuCount: os.cpus().length,
  totalMemoryMiB: os.totalmem() / 1024 / 1024,
  capability,
  nativeSha256: sha256,
  order,
  runs,
  paired,
  medians,
  fullHashesMatch: true,
};
fs.writeFileSync(
  path.join(resultRoot, 'memory-summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
console.log(JSON.stringify(summary));
