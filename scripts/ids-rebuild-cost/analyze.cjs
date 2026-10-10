'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [resultsArg, reportArg] = process.argv.slice(2);
const results = path.resolve(resultsArg);
const metadata = JSON.parse(fs.readFileSync(path.join(results, 'metadata.json')));
const files = fs.readdirSync(results).filter(f => /^\d+-[A-Z0-9]+\.json$/.test(f));
const data = files.map(f => JSON.parse(fs.readFileSync(path.join(results, f))));
const arms = ['DD', 'DN', 'ND', 'NN', 'DD2'];
const names = { DD: 'det/det', DN: 'det/named', ND: 'named/det', NN: 'named/named', DD2: 'det/det duplicate' };
const median = values => { const v = [...values].sort((a, b) => a - b); assert(v.length); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const fmt = n => n.toFixed(2);
const range = values => `${fmt(median(values))} [${fmt(Math.min(...values))}, ${fmt(Math.max(...values))}]`;
function rows(run) { return run.rows.filter(r => r.measured); }
function value(run, get) { return median(rows(run).map(get)); }
function runs(arm) { return data.filter(r => r.arm === arm).sort((a, b) => a.round - b.round); }
for (const arm of arms) {
  assert.equal(runs(arm).length, metadata.rounds);
  assert(runs(arm).every(r => rows(r).length === 3 && rows(r).every(row => row.editValidated && row.totalModules === metadata.fixture.target)));
}
const pair = (a, b, get = r => r.wallMs) => runs(a).map(run => value(run, get) - value(runs(b).find(bRun => bRun.round === run.round), get));
const summaries = {};
let text = `# Deterministic IDs: incremental leaf-edit cost\n\n## ${metadata.os} ${metadata.arch}, ${metadata.fixture.target.toLocaleString()} modules\n\n`;
text += `Published @rspack/core and @rspack/cli 2.2.8, Node ${metadata.node}; ${metadata.cpu}, ${metadata.cpus} logical CPUs, ${fmt(metadata.totalMemoryMiB)} MiB RAM; runner image ${metadata.runnerImage}. Run ${metadata.runId}, commit ${metadata.commit}.\n\n`;
text += `Development web target, legacy persistent cache, incremental warnings enabled, no devtool/HMR/minification/export optimizations. Generated public fixture: ${metadata.fixture.routes} dynamic imports, four shared JS cache groups, 40 CSS modules, and a cacheable JS loader for every JS module. ${metadata.rounds} interleaved blocks; five fresh OS processes per block, empty disk cache per process, one initial build and two warmup edits, then three validated measured leaf edits.\n\n`;
text += `Rebuild wall is the first done-hook timestamp minus invalid-hook timestamp, including 20 ms watch aggregation but excluding file-detection latency. CPU is process user/sys over the same interval (all native threads). Stats serialization and source/output validation happen after done. Peak RSS is OS process high-water RSS including initial build and instrumentation, not a resettable rebuild-only peak; steady RSS is sampled at done. No failed process is a sample.\n\n`;
text += `Every time/CPU/phase cell is median [min, max] of the ${metadata.rounds} process medians (three edits each); processes, not 21 pooled edits, are the replicate unit. RSS uses each process's final high-water peak and median measured done RSS.\n\n`;
text += '| IDs module/chunk | Rebuild ms | User CPU ms | Sys CPU ms | Peak RSS MiB | Done RSS MiB |\n| --- | ---: | ---: | ---: | ---: | ---: |\n';
for (const arm of arms) {
  const r = runs(arm);
  const wall = r.map(run => value(run, row => row.wallMs));
  summaries[arm] = { wallMs: median(wall), processMediansMs: wall, editRangeMs: [Math.min(...r.flatMap(run => rows(run).map(row => row.wallMs))), Math.max(...r.flatMap(run => rows(run).map(row => row.wallMs)))] };
  text += `| ${names[arm]} | ${range(wall)} | ${range(r.map(run => value(run, row => row.userMs)))} | ${range(r.map(run => value(run, row => row.sysMs)))} | ${range(r.map(run => run.metadata.peakRssMiB))} | ${range(r.map(run => value(run, row => row.steadyRssMiB)))} |\n`;
}
text += '\n| IDs | Module hash ms | Codegen ms | Chunk hash phase ms | Module-ID phase ms | Chunk-ID phase ms | Hash / codegen / chunk affected counts |\n| --- | ---: | ---: | ---: | ---: | ---: | --- |\n';
for (const arm of arms) {
  const r = runs(arm);
  const phases = ['create module hashes', 'code generation', 'hashing', 'module ids', 'chunk ids'].map(phase => range(r.map(run => value(run, row => row.phases[phase]))));
  const counts = key => [...new Set(r.flatMap(run => rows(run).map(row => row[key] ? `${row[key].affected}/${row[key].total}` : 'not logged')))].join(', ');
  text += `| ${names[arm]} | ${phases.join(' | ')} | ${counts('moduleHashes')} / ${counts('moduleCodegen')} / ${counts('chunkHashes')} |\n`;
}
text += '\nModule hash counts under deterministic fallback are source-inferred full selection, explicitly marked in raw results; that logger is absent when the pass is disabled. Codegen counts are selected/processed modules, including cache hits, not actual generator calls. Chunk hash phase is the encompassing `hashing` timer; its nested chunk/runtime timers remain in raw logs and must not be summed into it.\n\n';
text += '| Paired per-edit contrast | Extra ms, median [min, max] | Share of slower arm rebuild, paired median |\n| --- | ---: | ---: |\n';
const contrasts = [
  ['Both deterministic versus both named', 'DD', 'NN'],
  ['Deterministic modules with named chunks', 'DN', 'NN'],
  ['Deterministic chunks with named modules', 'ND', 'NN'],
  ['Deterministic modules with deterministic chunks', 'DD', 'ND'],
  ['Deterministic chunks with deterministic modules', 'DD', 'DN'],
];
const effects = {};
for (const [label, a, b] of contrasts) {
  const differences = pair(a, b);
  const percentages = runs(a).map((run, i) => differences[i] / value(run, row => row.wallMs) * 100);
  effects[label] = { medianMs: median(differences), rangeMs: [Math.min(...differences), Math.max(...differences)], sharePercent: median(percentages), pairedMs: differences };
  text += `| ${label} | ${range(differences)} | ${fmt(median(percentages))}% |\n`;
}
const aa = pair('DD2', 'DD');
const absAA = aa.map(Math.abs);
const moduleAllocation = pair('DN', 'NN').map((v, i) => (v + pair('DD', 'ND')[i]) / 2);
const chunkAllocation = pair('ND', 'NN').map((v, i) => (v + pair('DD', 'DN')[i]) / 2);
const denominator = runs('DD').map(run => value(run, row => row.wallMs));
const interaction = pair('DD', 'DN').map((v, i) => v - pair('ND', 'NN')[i]);
text += `\nA/A band (duplicate minus primary det/det): **${range(aa)} ms**; absolute paired noise median ${fmt(median(absAA))} ms, maximum ${fmt(Math.max(...absAA))} ms. This is an observed repeatability band, not a confidence interval. Individual-edit min/max ranges are in summary.json.\n\n`;
text += `The two deterministic choices share a whole-module-hash fallback, so their isolated penalties are not additive. Factorial interaction: ${range(interaction)} ms. A symmetric attribution (average each ID's marginal cost with the other axis named and deterministic) assigns modules **${range(moduleAllocation)} ms**, paired median **${fmt(median(moduleAllocation.map((v, i) => v / denominator[i] * 100)))}%** of det/det rebuild; chunks **${range(chunkAllocation)} ms**, **${fmt(median(chunkAllocation.map((v, i) => v / denominator[i] * 100)))}%**. The allocations sum to total overhead in each block, but medians need not sum. This is an accounting split, not independent causal phase attribution.\n\n`;
text += '### Warnings and cache behavior\n\n';
for (const arm of arms) {
  const warnings = [...new Set(runs(arm).flatMap(run => rows(run).flatMap(row => row.warnings)))];
  const cache = [...new Set(runs(arm).flatMap(run => rows(run).flatMap(row => row.codegenCache)))];
  text += `**${names[arm]}**\n\n${warnings.length ? warnings.map(w => '- ' + w.replace(/\n/g, ' ')).join('\n') : '- No fallback warnings.'}\n\n${cache.map(c => '- ' + c).join('\n')}\n\n`;
}
text += '### Limits\n\nOne generated topology and one content-only leaf edit, no dependency graph change. Shared runner scheduling, CPU frequency and persistent-cache background work can affect timing; load/memory snapshots and every raw build are preserved. No production-project extrapolation, no pure per-module slope claim from one size, and no claim of full code regeneration from codegen selection.\n';
fs.writeFileSync(reportArg, text);
fs.writeFileSync(path.join(results, 'summary.json'), JSON.stringify({ metadata, summaries, effects, aa: { pairedMs: aa, medianMs: median(aa), minMs: Math.min(...aa), maxMs: Math.max(...aa), maxAbsMs: Math.max(...absAA) }, attribution: { moduleMs: median(moduleAllocation), chunkMs: median(chunkAllocation), moduleSharePercent: median(moduleAllocation.map((v, i) => v / denominator[i] * 100)), chunkSharePercent: median(chunkAllocation.map((v, i) => v / denominator[i] * 100)), interactionMs: median(interaction) } }, null, 2));
console.log(text);
