'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const pins = require('./expected-merge-bindings.json');
const phases = ['before-watch', 'initial-applied', 'steady', 'steady-idle-10s', 'closed-references-held', 'dropped', 'dropped-idle-10s'];
const refs = {base: '2810c7fc89a82850f7bb29388c961fd5c77534f6', final: '3065e7ac0a3f1f9c48b61ce644cab1b588ebdfba'};
function median(values) { const a = [...values].sort((a,b) => a-b), n = a.length; assert(n); return n % 2 ? a[(n-1)/2] : (a[n/2-1] + a[n/2])/2; }
function interval(deltas) {
  const all = [];
  function visit(a) { if (a.length === deltas.length) { all.push(median(a)); return; } for (const x of deltas) visit([...a, x]); }
  visit([]); all.sort((a,b) => a-b);
  return [all[Math.floor(all.length * .025)], all[Math.ceil(all.length * .975) - 1]];
}
function check(rows) {
  assert.equal(rows.length, 10, 'exactly five pairs required');
  const keys = new Set();
  for (const row of rows) {
    assert(row.arm in refs && Number.isInteger(row.rep) && row.rep >= 1 && row.rep <= 5);
    assert(!keys.has(`${row.arm}-${row.rep}`), 'duplicate arm/rep'); keys.add(`${row.arm}-${row.rep}`);
    assert.equal(row.platform, 'Windows');
    assert.equal(row.outputParity, true);
    assert.equal(row.identity.source, refs[row.arm]);
    assert.equal(row.identity.sha256, pins.Windows[row.arm]);
    assert.equal(row.files, rows[0].files); assert.equal(row.contexts, rows[0].contexts); assert.equal(row.applications, rows[0].applications);
    assert.equal(row.watches.length, row.applications);
    assert(row.watches.every(w => w.files >= row.files && w.contexts >= row.contexts));
    for (const phase of phases) {
      const entries = row.snapshots.filter(x => x.phase === phase); assert.equal(entries.length, 1, phase);
      for (const key of ['privateBytes', 'workingSetBytes', 'handles']) assert(Number.isFinite(entries[0][key]) && entries[0][key] > 0);
      assert(Number.isFinite(entries[0].node.heapUsed));
    }
  }
}
function summarize(rows) {
  check(rows);
  const base = rows.filter(r => r.arm === 'base').sort((a,b) => a.rep-b.rep), head = rows.filter(r => r.arm === 'final').sort((a,b) => a.rep-b.rep);
  const metrics = {};
  for (const phase of phases) {
    metrics[phase] = {};
    for (const key of ['privateBytes', 'workingSetBytes', 'handles', 'heapUsed']) {
      const value = row => { const s = row.snapshots.find(s => s.phase === phase); return key === 'heapUsed' ? s.node.heapUsed : s[key]; };
      const b = base.map(value), h = head.map(value), d = h.map((x,i) => x-b[i]);
      metrics[phase][key] = {base: median(b), head: median(h), pairedDelta: median(d), interval95: interval(d), baseRange: [Math.min(...b), Math.max(...b)], headRange: [Math.min(...h), Math.max(...h)]};
    }
  }
  return {files: rows[0].files, folders: rows[0].contexts, applications: rows[0].applications, n: 5, collected: {base: base.map(r => r.collected), head: head.map(r => r.collected)}, metrics};
}
function fakeRows() {
  return ['base','final'].flatMap(arm => Array.from({length:5}, (_,i) => ({arm,rep:i+1,platform:'Windows',files:80000,contexts:3000,applications:4,outputParity:true,identity:{source:refs[arm],sha256:pins.Windows[arm]},watches:Array.from({length:4},()=>({files:80000,contexts:3000})),snapshots:phases.map(phase=>({phase,privateBytes:arm==='base'?100:120,workingSetBytes:90,handles:20,node:{heapUsed:10}}))})));
}
if (process.argv[2] === '--self-test') {
  const good = fakeRows(); assert.equal(summarize(good).metrics.steady.privateBytes.pairedDelta,20);
  assert.throws(() => summarize(good.slice(1)), /five pairs/);
  let bad = structuredClone(good); bad[0].identity.sha256 = pins.Windows.final; assert.throws(() => summarize(bad));
  bad = structuredClone(good); bad[0].files++; assert.throws(() => summarize(bad));
  bad = structuredClone(good); bad[0].snapshots[0].privateBytes = NaN; assert.throws(() => summarize(bad));
  bad = structuredClone(good); bad[0].rep = 2; assert.throws(() => summarize(bad), /duplicate/);
  bad = structuredClone(good); bad[0].outputParity = false; assert.throws(() => summarize(bad));
  console.log('SUMMARY_SELF_TEST=PASS: detects missing pair, wrong hash, swapped configuration, missing metric, duplicate pair and failed parity');
  process.exit(0);
}
const root = path.resolve(process.argv[2]);
const rows = [];
function walk(dir) { for (const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,e.name); if(e.isDirectory()) walk(p); else if (/^(base|final)-memory-[1-5]\.json$/.test(e.name)) rows.push(JSON.parse(fs.readFileSync(p,'utf8'))); } }
walk(root);
const grouped = new Map();
for(const row of rows) { const key = `${row.files}-${row.contexts}-${row.applications}`; if(!grouped.has(key)) grouped.set(key,[]); grouped.get(key).push(row); }
assert(grouped.size > 0, 'no successful samples');
if (process.argv.includes('--all')) assert.deepEqual([...grouped.keys()].sort(), ['40000-3000-4','80000-1000-4','80000-3000-4','80000-6000-4','160000-3000-4','80000-3000-1','80000-3000-5','80000-3000-20'].sort(), 'all eight matrix cells required');
const summaries = [...grouped.values()].map(summarize).sort((a,b)=>a.files-b.files || a.folders-b.folders || a.applications-b.applications);
const mb = x => (x/2**20).toFixed(2), n = x => x.toFixed(0);
let text = 'PR66_WINDOWS_MEMORY_SUMMARY_BEGIN\n| Files | Folders | Applications | Private base MiB | Private head MiB | Paired private delta [95%] MiB | RSS base/head MiB | Handles base/head | JS heap delta MiB |\n|---:|---:|---:|---:|---:|---|---|---|---:|\n';
for(const s of summaries) { const m=s.metrics.steady,p=m.privateBytes,r=m.workingSetBytes,h=m.handles; text+=`| ${s.files} | ${s.folders} | ${s.applications} | ${mb(p.base)} | ${mb(p.head)} | ${mb(p.pairedDelta)} [${p.interval95.map(mb).join(', ')}] | ${mb(r.base)}/${mb(r.head)} | ${n(h.base)}/${n(h.head)} | ${mb(m.heapUsed.pairedDelta)} |\n`; }
text += 'PR66_WINDOWS_MEMORY_SUMMARY_END\nPR66_WINDOWS_MEMORY_LIFECYCLE_BEGIN\n| Files/folders/apps | Initial delta | Steady delta | Idle 10s delta | Closed-held delta | Dropped delta | Dropped idle 10s delta | Watcher GC base/head |\n|---|---:|---:|---:|---:|---:|---:|---|\n';
for(const s of summaries) text+=`| ${s.files}/${s.folders}/${s.applications} | ${['initial-applied','steady','steady-idle-10s','closed-references-held','dropped','dropped-idle-10s'].map(p=>mb(s.metrics[p].privateBytes.pairedDelta)).join(' | ')} | ${s.collected.base.filter(x=>x.native).length}/5 / ${s.collected.head.filter(x=>x.native).length}/5 |\n`;
text += 'PR66_WINDOWS_MEMORY_LIFECYCLE_END\nPR66_WINDOWS_MEMORY_PHASES_BEGIN\n';
for(const s of summaries) {
 text += `${s.files}/${s.folders}/${s.applications}: `;
 text += phases.map(phase=>{const m=s.metrics[phase];return `${phase} private=${mb(m.privateBytes.base)}/${mb(m.privateBytes.head)} rss=${mb(m.workingSetBytes.base)}/${mb(m.workingSetBytes.head)} handles=${n(m.handles.base)}/${n(m.handles.head)}`;}).join('; ')+'\n';
}
text += 'PR66_WINDOWS_MEMORY_PHASES_END\n';
fs.writeFileSync(path.join(root,'memory-summary.json'),JSON.stringify(summaries,null,2)+'\n');
fs.writeFileSync(path.join(root,'memory-summary.md'),text);
console.log(text);
