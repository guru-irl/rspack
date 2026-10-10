'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [inputArg, outputArg] = process.argv.slice(2);
const input = path.resolve(inputArg);
const f = n => n.toFixed(2);
const median = values => { const v = [...values].sort((a, b) => a - b); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const load = (host, count) => {
  const dir = path.join(input, `ids-${host}-${count}`);
  return { summary: JSON.parse(fs.readFileSync(path.join(dir, 'measurement/results/summary.json'))),
    report: fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), dir };
};
const hosts = ['ubuntu-24.04', 'macos-15'];
const effectKey = 'Both deterministic versus both named';
let report = '# Per-edit cost of deterministic module and chunk IDs\n\n';
report += '## 60,000-module result\n\nPublic synthetic project, published Rspack 2.2.8, seven interleaved fresh processes per arm and three measured watch edits per process. The paired estimate is median of within-block differences of three-edit process medians; it is not the difference of pooled arm medians.\n\n';
report += '| GitHub host | Named/named rebuild ms | Deterministic/deterministic rebuild ms | Paired extra ms [min, max] | Paired overhead as share of det/det | A/A duplicate-minus-primary ms [min, max] |\n| --- | ---: | ---: | ---: | ---: | ---: |\n';
for (const host of hosts) {
  const { summary: s } = load(host, 60000);
  assert.equal(s.metadata.fixture.target, 60000);
  assert.equal(s.metadata.rounds, 7);
  const e = s.effects[effectKey];
  report += `| ${host} (${s.metadata.arch}) | ${f(s.summaries.NN.wallMs)} | ${f(s.summaries.DD.wallMs)} | **${f(e.medianMs)} [${e.rangeMs.map(f).join(', ')}]** | ${f(e.sharePercent)}% | ${f(s.aa.medianMs)} [${f(s.aa.minMs)}, ${f(s.aa.maxMs)}] |\n`;
}
report += '\n### Cost attributable to each ID choice at 60k\n\nThe ID choices are not additive: either deterministic plugin disables the same module-hash reuse. Report each choice with the other axis named, then use an explicitly symmetric allocation for its share of the combined overhead.\n\n';
report += '| Host | Deterministic modules, chunks named: paired extra ms | Deterministic chunks, modules named: paired extra ms | Symmetric module share: ms / % of det/det wall | Symmetric chunk share: ms / % of det/det wall |\n| --- | ---: | ---: | ---: | ---: |\n';
for (const host of hosts) {
  const { summary: s } = load(host, 60000);
  const a = s.attribution;
  report += `| ${host} | ${f(s.effects['Deterministic modules with named chunks'].medianMs)} | ${f(s.effects['Deterministic chunks with named modules'].medianMs)} | ${f(a.moduleMs)} / ${f(a.moduleSharePercent)}% | ${f(a.chunkMs)} / ${f(a.chunkSharePercent)}% |\n`;
}
report += '\nSymmetric allocation averages each ID choice\'s marginal cost with the other choice named and deterministic. It is an accounting split, not proof of independent phase costs. Per-block allocations sum to the total, but medians need not. Effects comparable to the A/A band are not precisely resolved.\n\n';
report += '## Scaling: 15k versus 60k\n\nBoth sizes were measured, not extrapolated. Module count grows 4× and async-import count grows 4× (750 to 3,000), so this tests scaling of the combined graph shape, not a module-only slope. Each size ran on a separate runner VM.\n\n';
report += '| Host | Modules | Named/named ms | Det/det ms | Paired ID overhead ms | Module hash delta ms | Codegen delta ms | ID overhead / 1k modules ms |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n';
const scalingNotes = [];
for (const host of hosts) {
  const overheads = [];
  for (const count of [15000, 60000]) {
    const { summary: s, dir } = load(host, count);
    const runs = fs.readdirSync(path.join(dir, 'measurement/results')).filter(name => /^\d+-(DD|NN)\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(dir, 'measurement/results', name))));
    const processPhase = (run, phase) => median(run.rows.filter(r => r.measured).map(r => r.phases[phase]));
    const phaseDelta = phase => median(runs.filter(r => r.arm === 'DD').map(r => processPhase(r, phase) - processPhase(runs.find(n => n.arm === 'NN' && n.round === r.round), phase)));
    const e = s.effects[effectKey].medianMs;
    overheads.push(e);
    report += `| ${host} | ${count.toLocaleString()} | ${f(s.summaries.NN.wallMs)} | ${f(s.summaries.DD.wallMs)} | ${f(e)} | ${f(phaseDelta('create module hashes'))} | ${f(phaseDelta('code generation'))} | ${f(e / (count / 1000))} |\n`;
  }
  scalingNotes.push(`${host}: observed paired overhead grows **${f(overheads[1] / overheads[0])}×** as module/import counts grow 4×. Interpret alongside that host's A/A dispersion; this ratio is not a universal performance model.`);
}
report += '\n' + scalingNotes.join('\n\n') + '\n\n';
report += '## Interpretation and measurement boundaries\n\n';
report += '- The fallback mechanism is confirmed by unsilenced warnings and full module codegen selection in deterministic arms. Named/named selects one codegen module. Deterministic arms mostly hit the legacy codegen cache, so this is global hashing/job selection/cache lookup overhead, not regeneration of all module bodies.\n';
report += '- The named baseline already hashes nearly all chunks in this shared splitChunks topology. Module hashing and codegen isolate the clearer ID-dependent pass differences; do not attribute all chunk hashing to deterministic IDs.\n';
report += '- RSS is process high-water memory including the initial build and instrumentation. Done RSS is a steady snapshot after compilation. Neither is a resettable per-edit peak. Wall and CPU stop before stats extraction and source validation.\n';
report += '- Fixture generation, measurement and all statistical analysis ran exclusively in public GitHub-hosted workflows. Earlier failed smoke runs are excluded and preserved separately.\n\n';
report += '## Provenance and raw data\n\n';
const s = load(hosts[0], 60000).summary;
report += `- Measurement workflow: https://github.com/guru-irl/rspack/actions/runs/${s.metadata.runId}\n- Measured commit: ${s.metadata.commit}, based on upstream main f2903b6482cb7a0fcdca912d23062bd94d3d5636.\n- Branch: https://github.com/guru-irl/rspack/tree/bench/ids-rebuild-cost\n- Four artifacts: ids-ubuntu-24.04-60000, ids-macos-15-60000, ids-ubuntu-24.04-15000, ids-macos-15-15000. Each contains raw per-build logging/warnings, process results, order/load snapshots, summary.json, npm lockfile and host metadata.\n- Fixture and driver: scripts/ids-rebuild-cost/{fixture,measure,run,analyze}.cjs. No Rspack source changes or local native build.\n\n`;
for (const count of [60000, 15000]) for (const host of hosts) {
  report += `---\n\n# Detailed host tables: ${host}, ${count.toLocaleString()} modules\n\n` + load(host, count).report.replace(/^# Deterministic IDs: incremental leaf-edit cost\n\n/, '') + '\n';
}
// Preserve exact warnings in raw JSON, but remove terminal color escapes in Markdown.
report = report.replace(/\x1b\[[0-9;]*m/g, '');
fs.writeFileSync(outputArg, report);
console.log(report.slice(0, report.indexOf('## Interpretation')));
