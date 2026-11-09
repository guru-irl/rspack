const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.realpathSync(process.argv[2]);
const out = path.resolve(process.argv[3]);
const scope = process.argv[4] || 'compiler';
fs.mkdirSync(out, { recursive: true });
const config = path.join(root, 'tests/rspack-test/rstack.config.mts');
const original = fs.readFileSync(config, 'utf8');
const setup = path.join(__dirname, 'verify-binding.mjs').split(path.sep).join('/');
const guard = path.join(__dirname, 'binding-guard.cjs').split(path.sep).join('/');
let changed = original.replace('const setupFilesAfterEnv = [', `const setupFilesAfterEnv = [\n    ${JSON.stringify(setup)},`)
  .replace('      testFilter,', '      testFilter: process.env.ALIAS_TEST_FILTER ?? testFilter,')
  .replace('retry: process.env.CI ? 3 : 0,', 'retry: 0,');
if (changed === original || !changed.includes('ALIAS_TEST_FILTER')) throw Error('Unknown test config');
fs.writeFileSync(path.join(out, 'rstack.config.original.mts'), original);
fs.writeFileSync(config, changed);
const env = { ...process.env, ALIAS_SOURCE_ROOT: root,
  NODE_OPTIONS: `--require=${JSON.stringify(guard)}` };
const cases = [['compiler-native', 'native-watcher', ['Compiler.test.mjs', '--project', 'base']]];
if (scope === 'linux') cases.push(
  ['native-api', '', ['--project', 'nativeWatcher']],
  ['watch-native', 'native-watcher', ['Watch.part1.test.mjs', 'Watch.part2.test.mjs', 'Watch.part3.test.mjs', '--project', 'base']]
);
try {
  for (const [name, filter, args] of cases) {
    const log = path.join(out, name + '.log');
    const fd = fs.openSync(log, 'w');
    const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--dir', 'tests/rspack-test', 'run', 'test', ...args], {
        cwd: root, env: { ...env, ALIAS_TEST_FILTER: filter }, stdio: ['ignore', fd, fd],
        shell: process.platform === 'win32'
      });
    fs.closeSync(fd);
    const text = fs.readFileSync(log, 'utf8').replace(/\u001b\[[0-9;]*m/g, '');
    console.log(text.split('\n').slice(-35).join('\n'));
    if (result.error) throw result.error;
    if (result.status !== 0 || !text.includes('BINDING_IDENTITY') || !/Tests\s+\d+ passed/.test(text)) {
      throw Error(`${name} failed: exit ${result.status}, log ${log}`);
    }
    fs.appendFileSync(path.join(out, 'gates.jsonl'), JSON.stringify({
      name, status: result.status, sha256: process.env.EXPECTED_BINDING_SHA256,
      summary: text.split('\n').filter(line => /Test Files|Tests\s+\d+ passed|Duration/.test(line))
    }) + '\n');
  }
} finally {
  fs.writeFileSync(config, original);
}
