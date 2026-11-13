// Compare c3 step receipts of one arm with Watchpack. Prints one line per step.
// usage: node c3-compare.cjs <arm.jsonl> <wp.jsonl>
const fs = require('node:fs');
const read = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
const [armFile, wpFile, mainFile] = process.argv.slice(2);
const a = read(armFile), w = read(wpFile);
const key = r => r.scenario + '/' + r.id;
const steps = rows => new Map(rows.filter(r => r.type === 'step').map(r => [key(r), r]));
const sa = steps(a), sw = steps(w);
const files = (r, k) => [...new Set(r.events.flatMap(e => e[k]))].sort();
let pass = 0, total = 0;
const failedKeys = [];
for (const [k, ref] of sw) {
  total++;
  const r = sa.get(k);
  if (!r) { failedKeys.push(k); console.log(`${k}\tMISSING`); continue; }
  const problems = [];
  if (r.delivered !== ref.delivered) problems.push(`delivered ${r.delivered} vs ${ref.delivered}`);
  if (JSON.stringify(r.output) !== JSON.stringify(ref.output)) problems.push(`output ${JSON.stringify(r.output)} vs ${JSON.stringify(ref.output)}`);
  for (const kind of ['modifiedFiles', 'removedFiles']) {
    const mine = new Set(files(r, kind));
    const miss = files(ref, kind).filter(f => !mine.has(f));
    if (miss.length) problems.push(`${kind} missing ${miss.join(',')}`);
  }
  const extra = files(r, 'modifiedFiles').filter(f => !files(ref, 'modifiedFiles').includes(f));
  if (!problems.length) pass++;
  else failedKeys.push(k);
  console.log(`${k}\t${problems.length ? 'DIFF ' + problems.join('; ') : 'OK'}${extra.length ? '\textra ' + extra.join(',') : ''}`);
}
for (const r of a.filter(r => r.type === 'failure' || r.type === 'init' || r.type === 'done')) console.log(`${r.type}\t${r.scenario || ''}\t${JSON.stringify(r.identity || r.error || '').slice(0, 600)}`);
console.log(`SUMMARY ${a[0] && a[0].platform} ${a[0] && a[0].arm} ${pass}/${total}`);
if (process.env.REQUIRE_REVIEWED_ROWS === '1') {
  const assert = require('node:assert/strict');
  const platform = a[0].platform;
  // Original head receipts in run 41220912949: Linux 20/27, macOS 25/31, Windows 24/31.
  const allowed = ['chain/chain-unlink-inner', 'rootcycle/rc-delete', 'retarget/rt-retarget', 'retarget/rt-edit-b', 'retarget/rt-back'];
  if (platform === 'darwin') allowed.push('rootcycle/rc-relink');
  else allowed.push('chain/chain-new-inner', 'chain/chain-new-deep');
  assert.equal(total, platform === 'linux' ? 27 : 31, 'missing reference rows');
  assert.equal(sa.size, total, 'missing or extra candidate rows');
  assert.equal(a.filter(r => r.type === 'step').length, total, 'duplicate candidate rows');
  assert(!a.some(r => r.type === 'failure'));
  for (const r of a) assert.equal(r.sha256, process.env.EXPECTED_BINDING_SHA256);
  for (const r of a.filter(r => r.type === 'init' || r.type === 'done')) assert.equal(r.identity.ok, true, 'binding identity');
  assert.equal(a.filter(r => r.type === 'done').length, 1);
  let regressions = failedKeys.filter(k => !allowed.includes(k));
  if(mainFile){
    const mr=read(mainFile),sm=steps(mr);assert.equal(sm.size,total,'missing main rows');assert.equal(mr.filter(r=>r.type==='step').length,total,'duplicate main rows');assert(!mr.some(r=>r.type==='failure'));assert.equal(mr.filter(r=>r.type==='done').length,1);
    for(const r of mr)assert.equal(r.sha256,process.env.MAIN_BINDING_SHA256);for(const r of mr.filter(r=>r.type==='init'||r.type==='done'))assert.equal(r.identity.ok,true);
    assert.deepEqual([...sm.keys()],[...sw.keys()]);assert.deepEqual([...sa.keys()],[...sw.keys()]);
    const good=(r,ref)=>r.delivered===ref.delivered&&JSON.stringify(r.output)===JSON.stringify(ref.output)&&['modifiedFiles','removedFiles'].every(kind=>files(ref,kind).every(f=>files(r,kind).includes(f)));
    regressions=[];const bothFail=[];for(const[k,ref]of sw){const main=sm.get(k),head=sa.get(k);if(good(main,ref)&&!good(head,ref))regressions.push(k);else if(!good(main,ref)&&!good(head,ref))bothFail.push(k);}
    console.log('MAIN_FLOOR '+JSON.stringify({rows:total,losses:regressions,bothFail}));
  }
  console.log('REVIEWED_ROWS ' + JSON.stringify({ platform, pass, total, failedKeys, allowed, regressions }));
  assert.deepEqual(regressions, [], 'c3 row passed on reviewed head but missed on merged candidate');
}
