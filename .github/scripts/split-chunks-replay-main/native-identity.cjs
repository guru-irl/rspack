const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { threadId } = require('node:worker_threads');

function hash(file) {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest('hex');
}

function canonical(file) {
  const real = fs.realpathSync(file);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function identity() {
  const expected = canonical(process.env.RSPACK_BINDING);
  const objects = process.report.getReport().sharedObjects;
  assert(Array.isArray(objects), 'Loaded-object report unavailable');
  const mapped = [
    ...new Set(
      objects
        .filter(
          (file) =>
            path.basename(file).toLowerCase().startsWith('rspack.') &&
            file.endsWith('.node'),
        )
        .map(canonical),
    ),
  ];
  assert.deepEqual(
    mapped,
    [expected],
    'The expected binding must be the only mapped Rspack binding',
  );
  const sha256 = hash(mapped[0]);
  assert.equal(sha256, process.env.EXPECTED_NATIVE_SHA);
  return { path: mapped[0], sha256 };
}

function memory() {
  const rssKiB = process.memoryUsage().rss / 1024;
  const resourceUsageMaxRssKiB = process.resourceUsage().maxRSS;
  let peakRssKiB = resourceUsageMaxRssKiB;
  let peakSource = 'resourceUsage.maxRSS';
  if (process.platform === 'win32' && peakRssKiB === 0) {
    const command = `[Console]::Write((Get-Process -Id ${process.pid}).PeakWorkingSet64)`;
    peakRssKiB =
      Number(
        execFileSync(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
          { encoding: 'utf8', windowsHide: true },
        ).trim(),
      ) / 1024;
    peakSource = 'PeakWorkingSet64';
  }
  assert(
    Number.isFinite(peakRssKiB) && peakRssKiB > 0,
    'Peak RSS counter unavailable',
  );
  assert(
    peakRssKiB >= rssKiB,
    `Peak RSS ${peakRssKiB} KiB is below current RSS ${rssKiB} KiB`,
  );
  return { rssKiB, peakRssKiB, peakSource, resourceUsageMaxRssKiB };
}

function install() {
  const native = fs.realpathSync(process.env.RSPACK_BINDING);
  assert.equal(hash(native), process.env.EXPECTED_NATIVE_SHA);
  const original = process.dlopen;
  process.dlopen = function (module, file, ...args) {
    if (
      path.basename(file).toLowerCase().startsWith('rspack.') &&
      file.endsWith('.node')
    ) {
      assert.equal(
        canonical(file),
        canonical(native),
        'Unexpected native binding',
      );
      assert.equal(hash(file), process.env.EXPECTED_NATIVE_SHA);
    }
    return original.call(this, module, file, ...args);
  };
  const binding = require(native);
  binding.default = binding;
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    return load.call(
      this,
      request === '@rspack/binding' ? native : request,
      parent,
      isMain,
    );
  };
  const record = {
    pid: process.pid,
    threadId,
    ...identity(),
    argv: process.argv,
  };
  assert(
    process.env.NATIVE_IDENTITY_LOG,
    'Native identity evidence file is required',
  );
  fs.appendFileSync(
    process.env.NATIVE_IDENTITY_LOG,
    JSON.stringify(record) + '\n',
  );
}

module.exports = { hash, identity, memory, install };
