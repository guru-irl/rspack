'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sources = {main: 'e04e75e8a56d1a1d0a920e34e166dd91617b118f', pr: '48af3db18a9aafd3077cf963fd7647e68e078b65', new: '2062b30908ff9a4099f7802dcbb3f011de5422a6'};
const arms = ['main','pr','new'];
const median = xs => { const s = [...xs].sort((a,b) => a-b); return s[Math.floor(s.length/2)]; };
const basename = file => file.replaceAll('\\', '/').split('/').pop();
function validate(row, identities) {
 assert.equal(row.sourceSha, sources[row.arm]);
 assert.equal(row.profile, 'release');
 assert.equal(row.nodeHash, identities[row.arm].sha256);
 assert.equal(row.coreIndexHash, identities[row.arm].coreIndexHash);
 assert.equal(row.coreIndexHash, identities.main.coreIndexHash);
 assert.equal(row.platform, {linux:'Linux', darwin:'macOS', win32:'Windows'}[identities[row.arm].platform]);
 assert.equal(row.arch, row.platform === 'macOS' ? 'arm64' : 'x64');
 assert.deepEqual(identities[row.arm].features, ['plugin', 'info-level']);
 assert.equal(row.aggregateTimeout, 200);
 assert(row.blockMs >= 1900 && row.blockMs < 10000);
 assert(row.quietMs >= 7900);
 assert.equal(row.correct, true);
 assert.deepEqual(row.values, ['a-new', 'b-new', 'c-new']);
 const names = row.scenario === 'multi' ? ['blocker','target'] : ['target'];
 assert.equal(row.correctBundles, names.length);
 assert.deepEqual(Object.keys(row.counters).sort(), [...names].sort());
 assert.equal(row.mapped.length, 1);
 assert(['process.report.sharedObjects', '/proc/self/maps'].includes(row.identityReport));
 assert.equal(row.rssSamples.length, 5);
 assert.equal(row.rssBaseline.phase, 'identity-checked');
 assert(row.rssBaseline.external < 8 * 1048576, 'binary-sized hash buffer retained at RSS baseline');
 assert(row.rssBaseline.t <= row.events[0].t);
 assert(row.rssBaseline.rss > 0);
 const unblock = row.events.find(e => e.kind === 'unblock').t;
 const writes = row.events.filter(e => e.kind === 'write');
 assert.deepEqual(writes.map(e => e.file), ['a.js', 'b.js', 'c.js']);
 assert(writes[1].t - writes[0].t >= 450 && writes[2].t - writes[1].t >= 450);
 assert(unblock - writes[2].t >= 950);
 for (const name of names) {
  for (const key of ['deliveries','raw','invalid','compilations','done','watchRun']) {
   const events = row.events.filter(e => e.name === name && e.kind === key);
   assert.equal(row.counters[name][key], events.length, `${name}/${key} differs from trace`);
   for (const e of events) assert(e.t >= unblock, 'event ran during blocked JavaScript');
  }
  assert(row.counters[name].compilations >= 1);
 }
 for (const key of Object.keys(row.totals)) assert.equal(row.totals[key], names.reduce((n,name) => n + row.counters[name][key], 0));
 const changed = row.events.filter(e => e.name === 'target' && e.kind === 'deliveries').flatMap(e => { assert(!e.error); return e.changed || []; });
 const raw = row.events.filter(e => e.name === 'target' && e.kind === 'raw').map(e => e.event.path);
 for (const file of ['a.js','b.js','c.js']) {
  assert(changed.some(p => basename(p) === file), `missing aggregate ${file}`);
  assert(raw.some(p => basename(p) === file), `missing raw ${file}`);
 }
 if (row.scenario === 'multi') assert.equal(row.counters.blocker.compilations, 1);
 for (const [i,s] of row.rssSamples.entries()) {
  assert(s.bytes > 0 && Number.isFinite(s.bytes));
  assert(s.quietMs >= 3900);
  if (i) assert(s.t - row.rssSamples[i-1].t >= 950);
 }
 assert.equal(row.steadyBytes, median(row.rssSamples.map(s => s.bytes)));
 assert(row.peakBytes >= Math.max(...row.rssSamples.map(s => s.bytes)));
 assert(row.osPeakBytes > 0 && Number.isFinite(row.osPeakBytes));
 assert.equal(row.peakBytes, Math.max(row.osPeakBytes, ...row.rssSamples.map(s => s.bytes)));
}
function controls(rows, identities) {
 const original = rows.find(row => row.arm === 'pr' && row.scenario === 'multi');
 const rejects = (label, mutate) => { const row = structuredClone(original); mutate(row); assert.throws(() => validate(row, identities), undefined, `control accepted: ${label}`); };
 rejects('wrong total', r => r.totals.compilations++);
 rejects('stale bundle', r => r.values[2] = 'c-old');
 rejects('wrong binding', r => r.nodeHash = '0'.repeat(64));
 rejects('wrong compiler assignment', r => r.events.find(e => e.kind === 'compilations' && e.name === 'target').name = 'blocker');
 rejects('missing raw event', r => r.events.splice(r.events.findIndex(e => e.kind === 'raw'), 1));
 rejects('binary-sized hash buffer at baseline', r => r.rssBaseline.external = 64 * 1048576);
 rejects('wrong aggregate count', r => r.totals.deliveries++);
 rejects('wrong peak RSS', r => r.peakBytes++);
 rejects('wrong steady median', r => r.steadyBytes++);
 rejects('missing RSS sample', r => r.rssSamples.pop());
 assert.throws(() => complete(rows.slice(1)), undefined, 'missing run accepted');
 assert.throws(() => complete([...rows, rows[0]]), undefined, 'duplicate run accepted');
 return '12 negative controls rejected';
}
function complete(rows) {
 assert.equal(rows.length, 30);
 for (const scenario of ['single','multi']) for (const arm of arms) for (let run=1; run<=5; run++) assert.equal(rows.filter(r => r.scenario === scenario && r.arm === arm && r.run === run).length, 1);
 for (const scenario of ['single','multi']) {
  const ordered = rows.filter(r => r.scenario === scenario).sort((a,b) => a.events[0].t-b.events[0].t);
  const wanted = [];
  for (let run=1; run<=5; run++) for (const arm of run%2 ? arms : [...arms].reverse()) wanted.push(`${arm}-${run}`);
  assert.deepEqual(ordered.map(r => `${r.arm}-${r.run}`), wanted, 'arm order differs');
 }
}
function main() {
 const dir = path.resolve(process.argv[2]);
 const identities = Object.fromEntries(arms.map(arm => [arm, JSON.parse(fs.readFileSync(path.join(dir, `identity-${arm}.json`), 'utf8'))]));
 const rows = fs.readdirSync(dir).filter(file => /^(single|multi)-(main|pr|new)-[1-5]\.json$/.test(file)).map(file => JSON.parse(fs.readFileSync(path.join(dir,file), 'utf8')));
 complete(rows);
 for (const row of rows) validate(row, identities);
 const controlResult = controls(rows, identities);
 const summary = {platform: rows[0].platform, identities, validation: controlResult, scenarios: {}};
 const lines = [`# ${summary.platform}`, '', 'Medians [minimum, maximum] from five alternating runs per arm. RSS is MiB.', '', '| Scenario and metric | Main e04e75e8 | Old head 48af3db1 | New head 2062b309 | New minus main |', '|---|---:|---:|---:|---:|'];
 for (const scenario of ['single','multi']) {
  const stats = {};
  const metrics = {compilations: r => r.totals.compilations, targetCompilations: r => r.counters.target.compilations, deliveries: r => r.totals.deliveries, raw: r => r.totals.raw, correctBundles: r => r.correctBundles, peakMiB: r => r.peakBytes/1048576, steadyMiB: r => r.steadyBytes/1048576};
  for (const [metric, value] of Object.entries(metrics)) {
   stats[metric] = {};
   const fmt = arm => {
    const xs = rows.filter(r => r.scenario === scenario && r.arm === arm).map(value);
    const s = stats[metric][arm] = {median: median(xs), min: Math.min(...xs), max: Math.max(...xs)};
    const n = x => metric.endsWith('MiB') ? x.toFixed(2) : String(x);
    return `${n(s.median)} [${n(s.min)}, ${n(s.max)}]`;
   };
   const a = fmt('main'), b = fmt('pr'), c = fmt('new');
   const delta = stats[metric].new.median - stats[metric].main.median;
   lines.push(`| ${scenario}, ${metric} | ${a} | ${b} | ${c} | ${delta >= 0 ? '+' : ''}${metric.endsWith('MiB') ? delta.toFixed(2) : delta} |`);
  }
  summary.scenarios[scenario] = stats;
 }
 lines.push('', `Validation passed for all 30 traces. ${controlResult}.`, '');
 fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
 fs.writeFileSync(path.join(dir, 'summary.md'), lines.join('\n'));
 console.log(lines.join('\n'));
}
if (require.main === module) main();
module.exports = {validate, complete, controls};
