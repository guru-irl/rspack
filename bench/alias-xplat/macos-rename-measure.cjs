const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const work = path.resolve('.bench-macos');
const root = path.resolve('source');
const out = path.join(work, 'results');
const casePath = 'compilerCases/native-watcher-rename-aggregation';
const caseMarker = 'native-watcher-rename-aggregation/';
const tests = [
  'rename', 'replace-new-immediate', 'replace-same-immediate',
  'replace-new-observed', 'replace-same-observed', 'roundtrip-immediate',
  'roundtrip-observed', 'replace-same-immediate-future',
  'roundtrip-immediate-future', 'recreate-same-immediate-future', 'directory'
];
const specs = {
  candidate: {
    sha: '80522e0611ed6f4b6260af91a3df8b99f7badf2c',
    tree: '823fc9f0488ccb5c4cb82c234220169eb68ea84d'
  },
  main: {
    sha: '1fb825ce951589c7cb39b51a0bb4c209960e97f6',
    tree: 'bb2bc70cb6385ad4133bcdff9cb3dcadf693e5d5'
  }
};
const stripAnsi = text => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');

function checkIdentity(spec, source, expectedHash, actualHash) {
  assert(source.startsWith(`${spec.sha} ${spec.tree} `), `Bad producer source: ${source}`);
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  assert.equal(actualHash, expectedHash, 'Producer binding hash mismatch');
}

function verifyProducers() {
  const identities = {};
  for (const [arm, spec] of Object.entries(specs)) {
    const bindingDir = path.join(work, 'bindings', arm);
    const files = fs.readdirSync(bindingDir).filter(file => file.endsWith('.node'));
    assert.equal(files.length, 1, `Expected exactly one ${arm} native binding`);
    const binding = fs.realpathSync.native(path.join(bindingDir, files[0]));
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binding)).digest('hex');
    const producer = path.join(work, 'producer', arm);
    const receipt = JSON.parse(fs.readFileSync(path.join(producer, 'binding.json'), 'utf8'));
    const source = fs.readFileSync(path.join(producer, 'source.txt'), 'utf8');
    checkIdentity(spec, source, receipt.sha256, sha256);
    identities[arm] = { ...spec, sha256, binding, producerRun: 42598933727, producerSource: source.trim() };
    console.log('PRODUCER_IDENTITY ' + JSON.stringify(identities[arm]));
  }
  fs.mkdirSync(out, { recursive: true });
  const json = JSON.stringify(identities, null, 2) + '\n';
  fs.writeFileSync(path.join(work, 'identities.json'), json);
  fs.writeFileSync(path.join(out, 'producer-identities.json'), json);
}

function parseEvents(text, expected) {
  const starts = [];
  const ends = [];
  for (const line of stripAnsi(text).split('\n')) {
    const parts = line.split(' | ');
    if (parts[1] === 'TEST_START') starts.push(parts[0]);
    if (parts[1] === 'TEST_END') ends.push({ key: parts[0], status: parts[3] });
  }
  const skipped = new Set(ends.filter(e => ['skip', 'todo', 'pending'].includes(e.status)).map(e => e.key));
  const activeStarts = starts.filter(key => !skipped.has(key));
  const activeEnds = ends.filter(e => !['skip', 'todo', 'pending'].includes(e.status));
  assert.equal(activeStarts.length, expected.length, 'Wrong non-skipped TEST_START count');
  assert.equal(activeEnds.length, expected.length, 'Wrong non-skipped TEST_END count');
  assert(activeEnds.every(e => ['pass', 'fail'].includes(e.status)), 'Unexpected TEST_END status');
  const identify = key => {
    const match = key.match(/native-watcher-rename-aggregation\/([^: >]+): should aggregate /);
    assert(match, `Unexpected executed test: ${key}`);
    return match[1];
  };
  const startNames = activeStarts.map(identify).sort();
  const endNames = activeEnds.map(e => identify(e.key)).sort();
  assert.deepEqual(startNames, [...expected].sort(), 'Wrong or duplicated started test names');
  assert.deepEqual(endNames, [...expected].sort(), 'Wrong or duplicated ended test names');
  assert.deepEqual([...activeStarts].sort(), activeEnds.map(e => e.key).sort(), 'Started/ended test keys differ');
  assert(text.includes(' | TEST_RUN_END | '), 'Missing TEST_RUN_END');
  return {
    started: activeStarts.length,
    passed: activeEnds.filter(e => e.status === 'pass').length,
    failed: activeEnds.filter(e => e.status === 'fail').map(e => identify(e.key)).sort(),
    skipped: skipped.size
  };
}

function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let value = 1;
  for (let i = 1; i <= k; i++) value = value * (n - k + i) / i;
  return value;
}
function fisher(a, n1, b, n2) {
  const total = a + b;
  const probability = x => combinations(n1, x) * combinations(n2, total - x) / combinations(n1 + n2, total);
  const observed = probability(a);
  let p = 0;
  for (let x = Math.max(0, total - n2); x <= Math.min(n1, total); x++) {
    const v = probability(x);
    if (v <= observed * (1 + 1e-10)) p += v;
  }
  return Math.min(1, p);
}

function selfTest() {
  const lines = tests.flatMap(name => {
    const key = `file > ${caseMarker}${name}: should aggregate ${name} like watchpack`;
    return [`${key} | TEST_START | time`, `${key} | TEST_END | time | pass | 1ms`];
  });
  const good = lines.join('\n') + '\n__GLOBAL__ | TEST_RUN_END | time\n';
  assert.deepEqual(parseEvents(good, tests).failed, []);
  const bad = good.replace(' | pass | ', ' | fail | ');
  assert.deepEqual(parseEvents(bad, tests).failed, ['rename']);
  assert.throws(() => parseEvents(good.replace(lines[0], ''), tests));
  assert.throws(() => parseEvents(good.replace(lines[1], lines[3]), tests));
  assert.throws(() => parseEvents(good.replace(' | pass | ', ' | skip | '), tests));
  assert.throws(() => parseEvents(good.replace('TEST_RUN_END', 'MISSING'), tests));
  assert.equal(fisher(0, 30, 0, 30), 1);
  assert(Math.abs(fisher(1, 10, 11, 14) - 0.0027594561852200836) < 1e-12);
  const source = `${specs.candidate.sha} ${specs.candidate.tree} subject`;
  const hash = 'a'.repeat(64);
  checkIdentity(specs.candidate, source, hash, hash);
  assert.throws(() => checkIdentity(specs.candidate, source, hash, 'b'.repeat(64)));
  assert.throws(() => checkIdentity(specs.main, source, hash, hash));
  console.log('SELF_TEST parser controls, source/hash controls, Fisher controls passed');
}

function trial(arm, number, identities, expected = tests, diagnostic = false) {
  const id = identities[arm];
  const label = `${diagnostic ? 'diagnostic' : 'trial'}-${String(number).padStart(2, '0')}-${arm}`;
  const log = path.join(out, `${label}.log`);
  const eventPath = path.join(root, 'rspack-test-event-report.txt');
  fs.rmSync(eventPath, { force: true });
  const guard = path.join(__dirname, 'binding-guard.cjs');
  const env = {
    ...process.env,
    ALIAS_SOURCE_ROOT: root,
    ALIAS_TEST_FILTER: casePath,
    NAPI_RS_NATIVE_LIBRARY_PATH: id.binding,
    EXPECTED_BINDING_SHA256: id.sha256,
    NODE_OPTIONS: `--require=${JSON.stringify(guard)}`
  };
  const args = ['--dir', 'tests/rspack-test', 'run', 'test', 'Compiler.test.mjs', '--project', 'base'];
  if (diagnostic) args.push('-t', expected[0]);
  const fd = fs.openSync(log, 'w');
  let result;
  const start = new Date().toISOString();
  try {
    result = spawnSync('pnpm', args, { cwd: root, env, stdio: ['ignore', fd, fd], timeout: 180000 });
  } finally {
    fs.closeSync(fd);
  }
  if (result.error) throw result.error;
  const text = stripAnsi(fs.readFileSync(log, 'utf8'));
  const bindingLines = text.split('\n').filter(line => line.includes('BINDING_IDENTITY '));
  assert(bindingLines.length > 0, `${label}: no test-process binding proof`);
  for (const line of bindingLines) {
    const proof = JSON.parse(line.slice(line.indexOf('BINDING_IDENTITY ') + 'BINDING_IDENTITY '.length));
    assert.equal(proof.sha256, id.sha256, `${label}: wrong in-process hash`);
    assert.equal(fs.realpathSync.native(proof.binding), id.binding, `${label}: wrong in-process binding`);
    console.log(`TEST_PROCESS ${label} BINDING_IDENTITY ${JSON.stringify(proof)}`);
  }
  assert(fs.existsSync(eventPath), `${label}: missing event report`);
  const events = stripAnsi(fs.readFileSync(eventPath, 'utf8'));
  fs.writeFileSync(path.join(out, `${label}.events.txt`), events);
  const counts = parseEvents(events, expected);
  assert.equal(result.status === 0, counts.failed.length === 0, `${label}: exit disagrees with test results`);
  const row = {
    arm, number, diagnostic, start, end: new Date().toISOString(),
    bindingSha256: id.sha256, exit: result.status, ...counts
  };
  console.log('TRIAL ' + JSON.stringify(row));
  if (counts.failed.length) {
    const evidence = text.split('\n').filter(line => /AssertionError|Error: Case| NATIVE_FAILURE_TIMELINE |^NATIVE_FAILURE_TIMELINE |^ FAIL /.test(line));
    for (const line of evidence) console.log(`${label} ${line}`);
  }
  return { row, text };
}

function addTrial(row) {
  fs.appendFileSync(path.join(out, 'trials.jsonl'), JSON.stringify(row) + '\n');
}

function summary(rows, identities, phase) {
  const byArm = Object.fromEntries(['candidate', 'main'].map(arm => [arm, rows.filter(r => r.arm === arm)]));
  const result = {
    phase, runner: process.env.RUNNER_NAME, runnerOS: process.env.RUNNER_OS,
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
    identities, arms: {}, perTest: []
  };
  for (const [arm, list] of Object.entries(byArm)) {
    result.arms[arm] = {
      runs: list.length,
      runsWithFailure: list.filter(r => r.failed.length).length,
      testStarts: list.reduce((n, r) => n + r.started, 0),
      testPasses: list.reduce((n, r) => n + r.passed, 0),
      testFailures: list.reduce((n, r) => n + r.failed.length, 0)
    };
  }
  const c = result.arms.candidate, m = result.arms.main;
  assert(c.runs && m.runs, 'Both comparison arms must have trials');
  result.fisherRunP = fisher(c.runsWithFailure, c.runs, m.runsWithFailure, m.runs);
  for (const name of tests) {
    const cf = byArm.candidate.filter(r => r.failed.includes(name)).length;
    const mf = byArm.main.filter(r => r.failed.includes(name)).length;
    result.perTest.push({ name, candidateFailures: cf, candidateRuns: c.runs, mainFailures: mf, mainRuns: m.runs, fisherP: fisher(cf, c.runs, mf, m.runs) });
  }
  result.result = c.runsWithFailure / c.runs <= m.runsWithFailure / m.runs
    ? 'SAME' : result.fisherRunP < 0.1 ? 'CANDIDATE-WORSE' : 'INCONCLUSIVE';
  return result;
}

function replaceOne(text, before, after) {
  assert.equal(text.split(before).length, 2, `Cannot uniquely instrument: ${before}`);
  return text.replace(before, after);
}

function diagnosticSource(original) {
  let text = replaceOne(original, 'const data = {', 'const timeline = [];\n\tlet timelinePassed = false;\n\tconst data = {');
  text = replaceOne(text, 'data.native.batches.push({',
    'timeline.push({ at: new Date().toISOString(), type: "batch", changed: normalize(batch.changedFiles), removed: normalize(batch.removedFiles) });\n\t\t\tdata.native.batches.push({');
  text = replaceOne(text, 'event => data.native.raw.push([event.kind, path.relative(dir, event.path)])',
    'event => { const relative = path.relative(dir, event.path); data.native.raw.push([event.kind, relative]); timeline.push({ at: new Date().toISOString(), type: "event", kind: event.kind, path: relative }); }');
  text = replaceOne(text, '\t\tif (operation === "directory") {', '\t\ttimeline.length = 0;\n\t\tif (operation === "directory") {');
  text = replaceOne(text, 'expect(data.native.batches).toEqual(expected);', 'expect(data.native.batches).toEqual(expected);\n\t\ttimelinePassed = true;');
  text = replaceOne(text, '\t} finally {\n\t\twp.close();',
    '\t} finally {\n\t\tif (!timelinePassed) console.error("NATIVE_FAILURE_TIMELINE " + JSON.stringify({ operation, timeline: timeline.filter(e => e.type === "event" ? e.path === "index.js" : e.changed.includes("index.js") || e.removed.includes("index.js")) }));\n\t\twp.close();');
  return text;
}

function diagnose(rows, identities) {
  const c = rows.filter(r => r.arm === 'candidate' && r.failed.length);
  const m = rows.filter(r => r.arm === 'main' && r.failed.length);
  if (!c.length || m.length) return { requested: false };
  const name = c[0].failed[0];
  const caseFile = path.join(root, 'tests/rspack-test/compilerCases/native-watcher-rename-aggregation.mjs');
  const original = fs.readFileSync(caseFile, 'utf8');
  try {
    fs.writeFileSync(caseFile, diagnosticSource(original));
    for (let attempt = 1; attempt <= 40; attempt++) {
      const { row, text } = trial('candidate', attempt, identities, [name], true);
      if (row.failed.length) {
        const lines = text.split('\n').filter(line => line.includes('NATIVE_FAILURE_TIMELINE '));
        assert(lines.length > 0, 'Failing diagnostic did not print a native event/batch timeline');
        fs.writeFileSync(path.join(out, 'diagnostic-timeline.txt'), lines.join('\n') + '\n');
        console.log('DIAGNOSTIC_TIMELINE ' + JSON.stringify({ name, attempt, lines }));
        return { requested: true, reproduced: true, name, attempt, lines };
      }
    }
    console.log(`DIAGNOSTIC_NO_REPRODUCTION ${name} after 40 extra targeted attempts`);
    return { requested: true, reproduced: false, name, attempts: 40 };
  } finally {
    fs.writeFileSync(caseFile, original);
  }
}

function main(phase) {
  assert(['paired', 'extra'].includes(phase), 'Expected paired or extra');
  assert.equal(process.env.CI, 'true', 'Streamed event reporter requires CI=true');
  const identities = JSON.parse(fs.readFileSync(path.join(work, 'identities.json'), 'utf8'));
  fs.mkdirSync(out, { recursive: true });
  let prior = [];
  if (phase === 'extra') {
    const previous = path.join(work, 'paired-receipt');
    const priorSummary = JSON.parse(fs.readFileSync(path.join(previous, 'summary.json'), 'utf8'));
    assert.notEqual(process.env.RUNNER_NAME, priorSummary.runner, 'Extra trials must use another runner');
    assert.equal(priorSummary.arms.candidate.runs, 30);
    assert.equal(priorSummary.arms.main.runs, 30);
    assert.equal(priorSummary.arms.candidate.runsWithFailure, 0);
    assert.equal(priorSummary.arms.main.runsWithFailure, 0);
    for (const arm of ['candidate', 'main']) assert.equal(priorSummary.identities[arm].sha256, identities[arm].sha256);
    prior = fs.readFileSync(path.join(previous, 'trials.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(prior.length, 60);
  }
  const config = path.join(root, 'tests/rspack-test/rstack.config.mts');
  const original = fs.readFileSync(config, 'utf8');
  const setup = path.join(__dirname, 'verify-binding.mjs').split(path.sep).join('/');
  let changed = replaceOne(original, 'const setupFilesAfterEnv = [', `const setupFilesAfterEnv = [\n    ${JSON.stringify(setup)},`);
  changed = replaceOne(changed, '      testFilter,', '      testFilter: process.env.ALIAS_TEST_FILTER ?? testFilter,');
  changed = replaceOne(changed, 'retry: process.env.CI ? 3 : 0,', 'retry: 0,');
  fs.writeFileSync(path.join(out, 'original-rstack.config.mts'), original);
  fs.writeFileSync(config, changed);
  const rows = [...prior];
  try {
    for (let number = 1; number <= 30; number++) {
      const arms = phase === 'paired' ? ['candidate', 'main'] : ['candidate'];
      for (const arm of arms) {
        const { row } = trial(arm, number, identities);
        rows.push(row);
        addTrial(row);
      }
    }
    const result = summary(rows, identities, phase);
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('SUMMARY_JSON ' + JSON.stringify(result));
    if (phase === 'paired') {
      const zero = result.arms.candidate.runsWithFailure === 0 && result.arms.main.runsWithFailure === 0;
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `bothzero=${zero}\n`);
    }
    try {
      result.diagnostic = diagnose(rows, identities);
    } catch (error) {
      result.diagnostic = { requested: true, error: String(error.stack || error) };
      console.error('DIAGNOSTIC_ERROR ' + result.diagnostic.error);
    }
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('FINAL_SUMMARY_JSON ' + JSON.stringify(result));
    console.log('RESULT: ' + result.result);
  } finally {
    fs.writeFileSync(config, original);
  }
}

const command = process.argv[2];
if (command === '--self-test') selfTest();
else if (command === '--verify-producers') verifyProducers();
else main(command);
