import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fork, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const output = path.resolve('../benchmark-results');
fs.mkdirSync(output, { recursive: true });
const scripts = path.resolve('../scripts/bench-tanstack-filter');
for (const file of ['build.mjs', 'vite-check.mjs']) fs.copyFileSync(path.join(scripts, file), path.resolve(file));
const pluginFile = path.resolve('node_modules/@tanstack/router-plugin/dist/esm/core/router-code-splitter-plugin.js');
const original = fs.readFileSync(pluginFile, 'utf8');
const needle = 'exclude: [tsrSplit, tsrShared],';
if (original.split(needle).length !== 2) throw new Error('Reference exclude patch must match exactly once');
const arms = {
  S: original,
  R: original.replace(needle, 'exclude: [/[?&]tsr-split(?:[=&]|$)/, /[?&]tsr-shared(?:[=&]|$)/],'),
  N: original.replace(needle, ''),
};
function arm(name) { fs.writeFileSync(pluginFile, arms[name]); fs.writeFileSync('src/data/m00000.ts', 'export const value = 0;\n'); }
function rss(pid) {
  try { return Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^RssAnon:\s+(\d+)/m)?.[1] ?? 0); }
  catch { return 0; }
}
function runChild(file, env, label) {
  return new Promise((resolve, reject) => {
    const log = fs.openSync(path.join(output, `${label}.log`), 'w');
    const child = fork(path.resolve(file), [], { env: { ...process.env, ...env }, stdio: ['ignore', log, log, 'ipc'] });
    fs.closeSync(log);
    let active = false;
    let peak = 0;
    let metric;
    const timer = setInterval(() => { if (active) peak = Math.max(peak, rss(child.pid)); }, 10);
    child.on('message', message => {
      if (message.type === 'start') { active = true; peak = rss(child.pid); child.send('ack'); }
      if (message.type === 'end') {
        const end = rss(child.pid); peak = Math.max(peak, end); active = false;
        metric = { ...message, peakRssAnonKiB: peak, endRssAnonKiB: end };
        child.send('ack');
      }
    });
    child.on('error', reject);
    child.on('exit', code => { clearInterval(timer); if (code !== 0) reject(new Error(`${label} exit ${code}`)); else resolve(metric); });
  });
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const pluginRequire = createRequire(pluginFile);
const unpluginEntry = pluginRequire.resolve('unplugin');
const unpluginDir = path.dirname(unpluginEntry);
fs.writeFileSync(path.join(output, 'environment.json'), JSON.stringify({
  platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length,
  cpuModel: os.cpus()[0].model, runner: 'ubuntu-24.04', packageTree: JSON.parse(spawnSync('npm', ['ls', '--all', '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout),
}, null, 2));
fs.copyFileSync('package-lock.json', path.join(output, 'package-lock.json'));
fs.copyFileSync(pluginFile, path.join(output, 'published-router-code-splitter-plugin.js'));
const instrumented = new Map();
for (const file of walk(unpluginDir).filter(f => /\.(mjs|js)$/.test(f))) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes('function patternToIdFilter(')) {
    fs.writeFileSync(path.join(output, 'published-unplugin-filter.js'), text);
    instrumented.set(file, text);
    const patched = text.replace('const matcher = picomatch(glob, { dot: true });', 'const matcher = picomatch(glob, { dot: true }); globalThis.__globCompile?.(pattern);');
    if (patched === text) throw new Error('Could not instrument picomatch construction');
    text = patched;
  }
  if (text.includes('function transformUse(')) {
    fs.writeFileSync(path.join(output, 'published-unplugin-adapter.js'), text);
    const start = text.indexOf('function transformUse(');
    const end = text.indexOf('\nfunction ', start + 10);
    const scope = text.slice(start, end < 0 ? text.length : end);
    const patched = scope.replace(/if \(!filter\(id\)\)\s*return \[\];/, `globalThis.__idFilterFactory = f => normalizeObjectHook('load', { filter: { id: f }, handler() {} }).filter;
    const observedResult = filter(id);
    globalThis.__referenceProbe?.(plugin.name, id, observedResult, 'rule');
    if (!observedResult) return [];`);
    if (patched === scope) throw new Error('Could not instrument transformUse');
    instrumented.set(file, text);
    text = text.replace(scope, patched).replace('normalizeObjectHook("load", plugin.transform)', 'globalThis.__withCompileContext(plugin.name, "rule", () => normalizeObjectHook("load", plugin.transform))');
  }
  if (text.includes('filter(this.resource, source)')) {
    if (!instrumented.has(file)) instrumented.set(file, text);
    const patched = text.replace(/if \(!filter\(this\.resource, source\)\)/, `const observedResult = filter(this.resource, source);
    globalThis.__referenceProbe?.(plugin.name, this.resource, observedResult, 'transform');
    if (!observedResult)`);
    if (patched === text) throw new Error('Could not instrument transform loader');
    fs.writeFileSync(path.join(output, `published-${path.basename(path.dirname(path.dirname(file)))}-transform-loader.js`), instrumented.get(file));
    text = patched.replace('normalizeObjectHook("transform", plugin.transform)', 'globalThis.__withCompileContext(plugin.name, "transform", () => normalizeObjectHook("transform", plugin.transform))');
  }
  if (instrumented.has(file)) fs.writeFileSync(file, text);
}
if (!instrumented.size) throw new Error('No diagnostic instrumented adapter');
const diagnostics = {};
for (const name of ['S', 'R', 'N']) {
  arm(name);
  const result = path.join(output, `diagnostic-${name}.json`);
  await runChild('build.mjs', { BENCH_CONDITION: 'cold', BENCH_DIAGNOSTIC: '1', BENCH_RESULT: result }, `diagnostic-${name}`);
  diagnostics[name] = JSON.parse(fs.readFileSync(result, 'utf8'));
}
for (const [file, text] of instrumented) fs.writeFileSync(file, text);
for (const [name, diag] of Object.entries(diagnostics)) for (const stage of ['rule', 'transform']) {
  for (const pattern of ['tsr-split', 'tsr-shared']) {
    const expected = name === 'S' ? diag.records[stage].length : 0;
    if ((diag.records.compiles[stage][pattern] ?? 0) !== expected) throw new Error(`Compile count mismatch ${name} ${stage} ${pattern}`);
  }
}
function accepted(diag, stage) { return diag.records[stage].filter(r => r.accepted).map(r => r.id).sort(); }
if (diagnostics.S.records.rule.some(r => r.stockExcludeMatch)) throw new Error('Stock exclude matched an observed rule ID');
for (const token of ['tsr-split', 'tsr-shared']) if (!diagnostics.S.records.rule.some(r => r.id.includes(token))) throw new Error(`Missing ${token} rule IDs`);
for (const name of ['R', 'N']) {
  for (const stage of ['rule', 'transform']) if (JSON.stringify(accepted(diagnostics.S, stage)) !== JSON.stringify(accepted(diagnostics[name], stage))) throw new Error(`Accepted ID mismatch ${name} ${stage}`);
  if (JSON.stringify(diagnostics.S.emitted) !== JSON.stringify(diagnostics[name].emitted)) throw new Error(`Diagnostic output mismatch ${name}`);
}
arm('S');
const viteFiles = walk(path.resolve('node_modules/vite/dist/node')).filter(f => /\.js$/.test(f));
let foundVite = false;
for (const file of viteFiles) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('function createIdFilter(') && text.includes('function createFilterForTransform(')) {
    fs.writeFileSync(path.join(output, 'published-vite-filter.txt'), text.slice(text.indexOf('function getMatcherString('), text.indexOf('function createFilterForTransform(') + 1700));
    fs.writeFileSync(file, text + '\nglobalThis.__viteIdFilterFactory = createIdFilter; globalThis.__viteTransformFilterFactory = createFilterForTransform;\n');
    const result = path.join(output, 'vite-diagnostic.json');
    await runChild('vite-check.mjs', { BENCH_RESULT: result }, 'vite-diagnostic');
    fs.writeFileSync(file, text);
    foundVite = true;
    break;
  }
}
if (!foundVite) throw new Error('Vite hook-filter implementation not found');
const vite = JSON.parse(fs.readFileSync(path.join(output, 'vite-diagnostic.json'), 'utf8'));
if (vite.ids.some(r => r.stockExcludeMatch || r.S !== r.R || r.S !== r.N)) throw new Error('Vite fixture filter mismatch');
for (const token of ['tsr-split', 'tsr-shared']) if (!vite.ids.some(r => r.id.includes(token))) throw new Error(`Missing Vite ${token} IDs`);
if (process.env.BENCH_DIAGNOSTICS_ONLY === '1') {
  arm('S');
  console.log('Excluded compile-count diagnostics complete.');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(diagnostics).map(([name, d]) => [name, { ruleCalls: d.records.rule.length, transformCalls: d.records.transform.length, compiles: d.records.compiles }])), null, 2));
  process.exit(0);
}
const samples = [];
const referenceManifests = {};
for (let round = 0; round < 5; round++) {
  const order = ['S', 'R', 'N'];
  order.push(...order.splice(0, round % 3));
  for (const name of order) for (const condition of ['cold', 'warm']) {
    arm(name);
    const label = `${condition}-${round + 1}-${name}`;
    const result = path.join(output, `${label}.json`);
    const metric = await runChild('build.mjs', { BENCH_CONDITION: condition, BENCH_RESULT: result }, label);
    const emitted = JSON.parse(fs.readFileSync(result, 'utf8')).emitted;
    if (!referenceManifests[condition]) referenceManifests[condition] = emitted;
    else if (JSON.stringify(referenceManifests[condition]) !== JSON.stringify(emitted)) throw new Error(`Output parity failed: ${label}`);
    const sample = { round: round + 1, order: order.join(','), arm: name, condition, ...metric };
    samples.push(sample);
    fs.writeFileSync(path.join(output, 'samples.json'), JSON.stringify(samples, null, 2));
    console.log(JSON.stringify(sample));
  }
}
arm('S');
const median = values => { const a = [...values].sort((a, b) => a - b); return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
function exactWilcoxon(differences) {
  const nonzero = differences.filter(d => d !== 0);
  if (!nonzero.length) return 1;
  const sorted = nonzero.map((d, i) => ({ a: Math.abs(d), i })).sort((a, b) => a.a - b.a);
  const ranks = Array(nonzero.length);
  for (let i = 0; i < sorted.length;) {
    let end = i + 1;
    while (end < sorted.length && sorted[end].a === sorted[i].a) end++;
    for (let j = i; j < end; j++) ranks[sorted[j].i] = (i + 1 + end) / 2;
    i = end;
  }
  const total = ranks.reduce((a, b) => a + b, 0);
  const observed = ranks.reduce((sum, r, i) => sum + (nonzero[i] > 0 ? r : 0), 0);
  let extreme = 0;
  for (let mask = 0; mask < 2 ** ranks.length; mask++) {
    let sum = 0;
    ranks.forEach((r, i) => { if (mask & (1 << i)) sum += r; });
    if (Math.abs(sum - total / 2) >= Math.abs(observed - total / 2)) extreme++;
  }
  return extreme / 2 ** ranks.length;
}
const metrics = ['wallMs', 'cpuMs', 'makeMs', 'peakRssAnonKiB', 'endRssAnonKiB'];
const summary = {};
for (const condition of ['cold', 'warm']) {
  summary[condition] = { medians: {}, comparisons: {}, files: Object.keys(referenceManifests[condition]).length };
  for (const name of ['S', 'R', 'N']) summary[condition].medians[name] = Object.fromEntries(metrics.map(k => [k, median(samples.filter(s => s.condition === condition && s.arm === name).map(s => s[k]))]));
  for (const [a, b] of [['S', 'R'], ['S', 'N'], ['R', 'N']]) {
    summary[condition].comparisons[`${b}-${a}`] = Object.fromEntries(metrics.map(k => {
      const pairs = Array.from({ length: 5 }, (_, i) => ['S', 'R', 'N'].map(arm => samples.find(s => s.round === i + 1 && s.condition === condition && s.arm === arm)));
      const differences = pairs.map(p => p.find(s => s.arm === b)[k] - p.find(s => s.arm === a)[k]);
      const percentages = pairs.map(p => 100 * (p.find(s => s.arm === b)[k] / p.find(s => s.arm === a)[k] - 1));
      return [k, { pairedMedianDelta: median(differences), pairedMedianPercent: median(percentages), exactTwoSidedP: exactWilcoxon(differences), differences }];
    }));
  }
}
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('All diagnostic IDs and cold/warm emitted bytes agree across fixture arms.');
console.log(JSON.stringify(summary, null, 2));
