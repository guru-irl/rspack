const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = fs.realpathSync(process.argv[2]);
const out = path.resolve(process.argv[3]);
const scope = process.argv[4] || 'compiler';
fs.mkdirSync(out, { recursive: true });
const config = path.join(root, 'tests/rspack-test/rstack.config.mts');
const original = fs.readFileSync(config, 'utf8');
const setup = path.join(__dirname, 'verify-binding.mjs').split(path.sep).join('/');
const guard = path.join(__dirname, 'binding-guard.cjs').split(path.sep).join('/');
const changed = original.replace('const setupFilesAfterEnv = [', `const setupFilesAfterEnv = [\n    ${JSON.stringify(setup)},`)
  .replace('      testFilter,', '      testFilter: process.env.ALIAS_TEST_FILTER ?? testFilter,')
  .replace('retry: process.env.CI ? 3 : 0,', 'retry: 0,');
assert(changed !== original && changed.includes('ALIAS_TEST_FILTER'), 'Unknown test config');
fs.writeFileSync(path.join(out, 'rstack.config.original.mts'), original);
fs.writeFileSync(config, changed);
const env = { ...process.env, ALIAS_SOURCE_ROOT: root, NODE_OPTIONS: `--require=${JSON.stringify(guard)}` };
const cases = [['compiler-native', 'native-watcher', ['Compiler.test.mjs', '--project', 'base']]];
if (scope === 'linux') cases.push(
  ['native-api', '', ['--project', 'nativeWatcher']],
  ['watch-native', 'native-watcher', ['Watch.part1.test.mjs', 'Watch.part2.test.mjs', 'Watch.part3.test.mjs', '--project', 'base']]
);
const stripAnsi = text => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
let failed = false;
try {
  for (const [name, filter, args] of cases) {
    // One retry, with the same inputs and no test-runner automatic retries.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const log = path.join(out, `${name}-${attempt}.log`);
      const fd = fs.openSync(log, 'w');
      const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['--dir', 'tests/rspack-test', 'run', 'test', ...args], {
          cwd: root, env: { ...env, ALIAS_TEST_FILTER: filter }, stdio: ['ignore', fd, fd], shell: process.platform === 'win32'
        });
      fs.closeSync(fd);
      const text = stripAnsi(fs.readFileSync(log, 'utf8'));
      fs.writeFileSync(log + '.plain', text);
      console.log(text.split('\n').slice(-35).join('\n'));
      if (result.error) throw result.error;
      const eventPath = path.join(root, 'rspack-test-event-report.txt');
      assert(fs.existsSync(eventPath), 'Missing streamed execution report');
      const eventText = stripAnsi(fs.readFileSync(eventPath, 'utf8'));
      fs.writeFileSync(path.join(out, `${name}-${attempt}.events.txt`), eventText);
      const lines = eventText.split('\n');
      const allStarts = lines.filter(line => line.includes(' | TEST_START | '));
      const ends = lines.filter(line => line.includes(' | TEST_END | '));
      const passed = ends.filter(line => /\| pass \|/.test(line));
      const skipped = ends.filter(line => /\| (?:skip|todo|pending) \|/.test(line));
      const failures = ends.filter(line => /\| fail \|/.test(line));
      const skippedNames = new Set(skipped.map(line => line.split(' | TEST_END | ')[0]));
      const starts = allStarts.filter(line => !skippedNames.has(line.split(' | TEST_START | ')[0]));
      const caseCounts = {};
      if (name === 'compiler-native') {
        const names = fs.readdirSync(path.join(root, 'tests/rspack-test/compilerCases')).filter(file => file.startsWith('native-watcher-')).map(file => file.replace(/\.mjs$/, ''));
        for (const caseName of names) {
          const matches = line => line.includes(`${caseName} > `);
          caseCounts[caseName] = { started: starts.filter(matches).length, passed: passed.filter(matches).length, failed: failures.filter(matches).length };
        }
      }
      const countsValid = starts.length > 0 && passed.length === starts.length && failures.length === 0 &&
        Object.values(caseCounts).every(row => row.started > 0 && row.passed === row.started && row.failed === 0);
      const ok = result.status === 0 && text.includes('BINDING_IDENTITY') && countsValid;
      const receipt = { name, attempt, exit: result.status, ok, sha256: process.env.EXPECTED_BINDING_SHA256,
        started: starts.length, passed: passed.length, skipped: skipped.length, failed: failures.length, cases: caseCounts,
        summary: text.split('\n').filter(line => /Test Files|Tests\s+\d+ passed|Duration/.test(line)) };
      fs.appendFileSync(path.join(out, 'gates.jsonl'), JSON.stringify(receipt) + '\n');
      console.log('REAL_EXECUTIONS ' + JSON.stringify(receipt));
      if (ok) break;
      if (attempt === 2) failed = true;
    }
  }
} finally { fs.writeFileSync(config, original); }
if (failed) throw Error('Native watcher execution gate failed twice; inspect receipts');
