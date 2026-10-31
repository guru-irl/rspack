// Compare c3 step receipts of one arm with Watchpack. Prints one line per step.
// usage: node c3-compare.cjs <arm.jsonl> <wp.jsonl>
const fs = require('node:fs');
const read = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
const [armFile, wpFile] = process.argv.slice(2);
const a = read(armFile), w = read(wpFile);
const key = r => r.scenario + '/' + r.id;
const steps = rows => new Map(rows.filter(r => r.type === 'step').map(r => [key(r), r]));
const sa = steps(a), sw = steps(w);
const files = (r, k) => [...new Set(r.events.flatMap(e => e[k]))].sort();
let pass = 0, total = 0;
for (const [k, ref] of sw) {
  total++;
  const r = sa.get(k);
  if (!r) { console.log(`${k}\tMISSING`); continue; }
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
  console.log(`${k}\t${problems.length ? 'DIFF ' + problems.join('; ') : 'OK'}${extra.length ? '\textra ' + extra.join(',') : ''}`);
}
for (const r of a.filter(r => r.type === 'failure' || r.type === 'init' || r.type === 'done')) console.log(`${r.type}\t${r.scenario || ''}\t${JSON.stringify(r.identity || r.error || '').slice(0, 600)}`);
console.log(`SUMMARY ${a[0] && a[0].platform} ${a[0] && a[0].arm} ${pass}/${total}`);
