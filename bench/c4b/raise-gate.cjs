const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [kind, capArg, root] = process.argv.slice(2);
const cap = Number(capArg);
const sets = {
  shared: ['adv-c4.cjs', 'limitmc-starve,limitmc-late,limitsep-starve', 27, []],
  combined: ['adv-c3.cjs', 'limit,limitrec,limitretry,limitdrop,limitdrop2-ctx,limitdrop2-file', 42, ['limit:N06', 'limitdrop:Q05']],
  sequential: ['adv-c3.cjs', 'limit,limitrec', 15, ['limit:N06']],
  retained: ['adv-retained-folder.cjs', 'limitretain', 8, []]
};
assert(sets[kind] && [30, 300].includes(cap) && ['real', 'link'].includes(root));
const [driver, sessions, wantedRows, allowedFailures] = sets[kind];
const results = path.join(process.env.GITHUB_WORKSPACE, '.c4b/results');
fs.mkdirSync(results, { recursive: true });
let ok = false;
for (let attempt = 1; attempt <= 2; attempt++) {
  const tag = `${kind}${cap}-attempt${attempt}`;
  const env = { ...process.env, NSLIMIT: String(cap), PREFIX: path.join(process.env.GITHUB_WORKSPACE, 'bench/c4b/nslimit.sh') };
  if (cap === 300 && kind !== 'retained') env.LIMIT_DIRS = '400';
  else delete env.LIMIT_DIRS;
  const command = spawnSync('bash', ['bench/c4b/arm.sh', 'fix', driver, tag, root, sessions], { env, stdio: 'inherit' });
  const prefix = path.join(results, `${tag}-${root}-fix`);
  let receipt;
  try {
    assert.equal(command.status, 0, 'arm wrapper exit');
    const commands = fs.readFileSync(path.join(results, 'commands.tsv'), 'utf8').trim().split('\n');
    const last = commands.at(-1).split('\t');
    assert.equal(last[1], `${tag}-${root}-fix`);
    assert.equal(last[2], '0', 'actual driver exit');
    assert.equal(last[3], process.env.CANDIDATE_BINDING_SHA256);
    const rows = fs.readFileSync(prefix + '.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
    const identities = rows.filter(row => row.type === 'identity');
    assert.equal(identities.length, 1);
    assert.equal(identities[0].sha, process.env.CANDIDATE_BINDING_SHA256);
    assert.equal(fs.realpathSync(identities[0].binding), fs.realpathSync(last[4]));
    assert(fs.readFileSync(prefix + '.stderr', 'utf8').includes(`nslimit=${cap}`));
    assert(!rows.some(row => ['failure', 'unsettled', 'recovery-timeout'].includes(row.type)));
    assert(!rows.some(row => row.id === 'INIT' && row.errors?.length));
    const steps = rows.filter(row => row.type === 'row' && row.id !== 'INIT');
    const summary = rows.filter(row => row.type === 'summary');
    assert.equal(summary.length, 1);
    assert.equal(steps.length, wantedRows, 'real row count');
    assert.equal(new Set(steps.map(row => row.scenario + ':' + row.id)).size, wantedRows, 'unique row count');
    const failed = steps.filter(row => !row.ok).map(row => row.scenario + ':' + row.id);
    assert.equal(summary[0].rows, steps.length);
    assert.equal(summary[0].passed, steps.length - failed.length);
    assert.deepEqual(summary[0].failed, failed);
    const unexpected = failed.filter(id => !allowedFailures.includes(id));
    assert.deepEqual(unexpected, [], 'row passed on reviewed head but missed on merged candidate');
    receipt = { kind, cap, root, attempt, directories: Number(env.LIMIT_DIRS || 40), ok: true, rows: steps.length, passed: steps.length - failed.length, failed, allowedFailures,
      sha256: identities[0].sha, binding: identities[0].binding };
    ok = true;
  } catch (error) { receipt = { kind, cap, root, attempt, ok: false, error: error.stack, sha256: process.env.CANDIDATE_BINDING_SHA256 }; }
  fs.appendFileSync(path.join(results, 'raise-gates.jsonl'), JSON.stringify(receipt) + '\n');
  console.log('LIMIT_GATE ' + JSON.stringify(receipt));
  if (ok) break;
}
if (!ok) process.exitCode = 1;
