import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/rsbuild';
const out = process.env.RESULT_DIR;
const arm = process.env.ARM;
const scenario = process.env.SCENARIO || 'correctness';
fs.mkdirSync(out, { recursive: true });
const now = () => performance.now();
const pause = ms => new Promise(r => setTimeout(r, ms));
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const resolver = id => id.includes('_tanstack-start-server-fn-resolver.js');
let step = 'initial';
let lastEvent = now();
let peak = process.memoryUsage().rss;
const active = new Set();
const builds = [];
const events = [];
const checks = [];
const current = new Map();
const compilers = new Map();
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
const event = (name, kind, extra = {}) => { const t = now(); lastEvent = t; events.push({ step, name, kind, t, wallMs:Date.now(), ...extra }); };
const normalize = s => s.replaceAll(process.cwd(), '<APP>').replaceAll('\\', '/');
const probe = { name: 'watch-observer', setup(api) {
  api.modifyRspackConfig((config, { environment }) => {
    config.devtool = false;
    config.plugins.push({ apply(compiler) {
      compilers.set(environment.name,compiler);
      compiler.hooks.watchRun.tap({ name: 'WatchObserver', stage: -10000 }, () => {
        active.add(environment.name); event(environment.name, 'watchRun');
      });
      compiler.hooks.make.tap({name:'WatchMakeObserver',stage:-10000},()=>event(environment.name,'make'));
      compiler.hooks.finishMake.tap({name:'WatchMakeObserver',stage:10000},()=>event(environment.name,'finishMake'));
      compiler.hooks.thisCompilation.tap('WatchObserver', compilation => {
        compilation.hooks.seal.tap('WatchSealObserver',()=>event(environment.name,'seal'));
        compilation.hooks.afterSeal.tap('WatchSealObserver',()=>event(environment.name,'afterSeal'));
        const record = { step, name: environment.name, rebuilt: [], built: [], errors: [], modules: {}, assets: [] };
        current.set(environment.name, record);
        const original = compilation.rebuildModule.bind(compilation);
        compilation.rebuildModule = (mod, cb) => { record.rebuilt.push(normalize(mod.identifier())); return original(mod, cb); };
        compilation.hooks.succeedModule.tap('WatchObserver', mod => record.built.push(normalize(mod.identifier())));
        compilation.hooks.finishModules.tap({ name: 'WatchObserver', stage: 10000 }, modules => {
          for (const mod of modules) {
            const id = normalize(mod.identifier());
            if (id.includes('<APP>/src/') || resolver(id)) record.modules[id] = normalize(String(mod.originalSource()?.source() ?? ''));
          }
        });
        compilation.hooks.processAssets.tap({ name: 'WatchObserver', stage: 6000 }, () => {
          for(const asset of compilation.getAssets()) {if(asset.name==='assets/js/index.js') fs.writeFileSync(path.join(out,`${step}-client-entry.txt`),String(asset.source.source()));}
          record.assets = compilation.getAssets().filter(a => !a.name.includes('hot-update')).map(a => ({ name: a.name, bytes: a.source.size(), hash: hash(String(a.source.source())) })).sort((a,b) => a.name.localeCompare(b.name));
        });
      });
      compiler.hooks.done.tap({ name: 'WatchObserver', stage: 10000 }, stats => {
        const record = current.get(environment.name);
        record.ms = stats.endTime - stats.startTime;
        record.hash=stats.hash;
        record.errors = stats.toJson({ all: false, errors: true }).errors;
        record.generated = normalize(globalThis.__watchVirtualState?.generateCurrentResolverContent(true) ?? '');
        builds.push(record); active.delete(environment.name); event(environment.name, 'done', { ms: record.ms, errors: record.errors.length });
      });
      compiler.hooks.failed.tap('WatchObserver', error => { event(environment.name, 'failed', { error: String(error) }); });
    } });
  });
} };
const waitIdle = async (minimum = 0) => {
  const start = now();
  while (now() - start < 120000) {
    const relevant = events.filter(e => e.step === step);
    if (!active.size && relevant.filter(e => e.kind === 'done').length >= minimum && now() - lastEvent > 800) return;
    await pause(25);
  }
  throw new Error(`watch never settled: ${step}, active=${[...active]}`);
};
const baselineFns = fs.readFileSync('src/functions.ts', 'utf8');
const baselineLeaf = fs.readFileSync('src/Leaf.tsx', 'utf8');
const base = { alpha: 'alpha-public', beta: 'beta-public', gamma: 'gamma-public' };
let knownIds = {};
const htmlDecode = s => s.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
const rpc = async id => {
  const response = await fetch(`http://localhost:3100/_serverFn/${encodeURIComponent(id)}`, { headers: { 'x-tsr-serverFn': 'true', origin: 'http://localhost:3100', 'sec-fetch-site': 'same-origin' } });
  return { status: response.status, response: await response.text() };
};
const sample = async (expected, leaf, removed = [], addedRoute = false) => {
  const responses = {};
  for (const route of ['/', '/page-001', '/page-025', '/page-060', ...(addedRoute ? ['/extra'] : [])]) {
    const response = await fetch(`http://localhost:3100${route}`);
    const html = await response.text();
    assert.equal(response.status, 200, `${step} ${route}: SSR HTTP status, ${html.slice(0,300)}`);
    assert.ok(html.includes(leaf), `${step} ${route}: leaf content`);
    const pre = /<pre>([\s\S]*?)<\/pre>/.exec(html)?.[1];
    const data = JSON.parse(htmlDecode(pre ?? 'null'));
    assert.deepEqual(data, expected, `${step} ${route}: SSR data`);
    responses[route] = { status: response.status, data, leaf, css: [...html.matchAll(/<link[^>]+href="([^"]+\.css[^\"]*)"/g)].map(m => m[1]).sort(), scripts: [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).sort() };
    fs.writeFileSync(path.join(out, `${step}-${route.replaceAll('/', '_')}.html`), html);
  }
  const latest = Object.fromEntries(['client','ssr'].map(name => [name, builds.filter(b => b.name === name).at(-1)]));
  assert.ok(latest.ssr && latest.client, `${step}: both output snapshots`);
  for (const [name,b] of Object.entries(latest)) assert.equal(b.errors.length,0,`${step}: ${name} final compile errors`);
  const compiled = Object.entries(latest.ssr.modules).find(([id]) => resolver(id))?.[1];
  assert.equal(compiled, latest.ssr.generated, `${step}: compiled resolver matches final shared resolver`);
  const ids = {};
  for (const match of compiled.matchAll(/'([^']+)': \{\s*functionName: '([^']+)'/g)) ids[match[2].replace('_createServerFn_handler', '')] = match[1];
  const calls = {};
  for (const [name, value] of Object.entries(expected)) {
    assert.ok(ids[name], `${step}: ${name} id exists`);
    const result = await rpc(ids[name]);
    assert.equal(result.status, 200, `${step}: ${name} RPC status, ${result.response}`);
    assert.ok(result.response.includes(value), `${step}: ${name} RPC response`);
    calls[name] = result;
  }
  const removedCalls = {};
  for (const name of removed) {
    assert.ok(knownIds[name], `${step}: ${name} previous id`);
    assert.equal(ids[name], undefined, `${step}: ${name} removed resolver entry`);
    const result = await rpc(knownIds[name]);
    assert.ok(result.status >= 400, `${step}: removed id fails`);
    removedCalls[name] = result;
  }
  knownIds = { ...knownIds, ...ids };
  const es = events.filter(e => e.step === step);
  const starts = es.filter(e => e.kind === 'watchRun');
  const ends = es.filter(e => e.kind === 'done');
  const timing = { spanMs: Math.max(...ends.map(e => e.t)) - Math.min(...starts.map(e => e.t)), clientMs: builds.filter(b => b.step === step && b.name === 'client').reduce((n,b)=>n+b.ms,0), ssrMs: builds.filter(b=>b.step===step&&b.name==='ssr').reduce((n,b)=>n+b.ms,0), peakRss: peak, postRss: process.memoryUsage().rss };
  const overlap = starts.some(c => c.name === 'client' && starts.some(s => s.name === 'ssr' && s.t >= c.t && s.t < ends.find(e => e.name==='client' && e.t > c.t)?.t));
  const snapshots = Object.fromEntries(Object.entries(latest).map(([name,b]) => [name, { modules: b.modules, assets: b.assets }]));
  fs.writeFileSync(path.join(out, `${step}-outputs.json`), JSON.stringify(snapshots, null, 2));
  const check = { step, responses, calls, removedCalls, timing, overlap, resolverRebuilds: builds.filter(b=>b.step===step).flatMap(b=>b.rebuilt).filter(resolver).length };
  checks.push(check); console.log('CHECK', JSON.stringify(check));
  fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
  if (scenario === 'red-overlap' && step === 'leaf-1') assert.ok(overlap, 'warm client and SSR must overlap');
  if (arm !== 'stock' && scenario !== 'red-recovery' && step.startsWith('leaf-')) assert.equal(check.resolverRebuilds, 0, 'leaf keeps resolver gate fast path');
};
const edit = async (name, file, content, expected, leaf='Public leaf baseline', removed=[], rapid, addedRoute=false) => {
  step=name; peak=process.memoryUsage().rss; lastEvent=now();
  fs.writeFileSync(file, content);
  if (rapid !== undefined) {
    // Save again while a real compiler pass is active, not merely before the debounce expires.
    const deadline=now()+10000;
    while (!events.some(e=>e.step===step && e.kind==='watchRun')) { assert.ok(now()<deadline,'first save starts a watch pass'); await pause(5); }
    fs.writeFileSync(file, rapid);
  }
  await waitIdle(2);
  await sample(expected, leaf, removed, addedRoute);
};
let server;
let readyTime;
let readiness;
const started=now();
try {
  const rsbuild = await createRsbuild({ config: { plugins:[pluginReact(),tanstackStart(),probe], performance:{buildCache:false}, server:{port:3100,strictPort:true,open:false} } });
  server=await rsbuild.startDevServer();
  readiness=(async()=>{
    const deadline=now()+120000;
    while(now()<deadline) {
      try {
        const r=await fetch('http://localhost:3100/');
        const html=await r.text();
        if(r.status===200 && html.includes('alpha-public') && html.includes('beta-public') && html.includes('gamma-public')) {readyTime=now();return;}
      } catch {}
      await pause(25);
    }
    throw new Error('cold SSR request readiness timeout');
  })();
  await waitIdle(2);
  await readiness;
  await sample(base,'Public leaf baseline');
  const cold={ ssrReadyMs: readyTime-started, firstSsrDoneMs:events.find(e=>e.name==='ssr'&&e.kind==='done').t-started, finalReadyMs: events.filter(e=>e.kind==='done').at(-1).t-started, peakRss:peak, arm };
  fs.writeFileSync(path.join(out,'cold.json'),JSON.stringify(cold,null,2));
  if (scenario==='red-after-make') {
    const e=events.filter(e=>e.step==='initial');
    const clientFinish=e.find(x=>x.name==='client'&&x.kind==='finishMake').t;
    const clientDone=e.find(x=>x.name==='client'&&x.kind==='done').t;
    const ssrMake=e.find(x=>x.name==='ssr'&&x.kind==='make').t;
    assert.ok(ssrMake>=clientFinish && ssrMake<clientDone,'after-make starts SSR make between client finishMake and done');
  } else if (scenario==='cold') {}
  else if (scenario==='red-recovery') {
    step='resolver-recovery'; peak=process.memoryUsage().rss; lastEvent=now();
    globalThis.__watchVirtualState.tryUpdateServerFnResolver('export async function getServerFnById() { throw new Error("stale resolver") }\n');
    compilers.get('ssr').watching.invalidateWithChangesAndRemovals(new Set([globalThis.__watchVirtualState.serverFnResolverPath]),new Set());
    await waitIdle(1); await sample(base,'Public leaf baseline');
  } else {
    const edits=scenario==='warm'?10:scenario==='red-overlap'?1:2;
    for(let i=1;i<=edits;i++) await edit(`leaf-${i}`,'src/Leaf.tsx',i%2?baselineLeaf.replace('baseline','changed'):baselineLeaf,base,i%2?'Public leaf changed':'Public leaf baseline');
    if(scenario==='correctness' || scenario==='aa-route') {
      const route=`import { createFileRoute } from '@tanstack/react-router';\nimport * as functions from '../functions';\nimport { Page } from '../Page';\nexport const Route = createFileRoute('/extra')({ loader:async()=>Object.fromEntries(await Promise.all(Object.entries(functions).sort(([a],[b])=>a.localeCompare(b)).map(async([name,fn])=>[name,await fn()]))), component: () => <Page title="Extra route" /> });\n`;
      await edit('lazy-route','src/routes/extra.tsx',route,base,undefined,[],undefined,true);
      if(scenario!=='aa-route') {
      await edit('css-import','src/Leaf.tsx',`import './extra.css';\n${baselineLeaf}`,base,undefined,[],undefined,true);
      for(const kind of ['add','rename','remove','body']) {
        for(const rapid of [false,true]) {
          const suffix=rapid?'rapid':'single';
          let text,expected,removed=[];
          if(kind==='add') { text=baselineFns+`\nexport const delta = createServerFn({ method:'GET' }).handler(async()=> 'delta-public');\n`; expected={...base,delta:'delta-public'}; }
          if(kind==='rename') { text=baselineFns.replaceAll('beta','renamed'); expected={alpha:base.alpha,gamma:base.gamma,renamed:'renamed-public'}; removed=['beta']; }
          if(kind==='remove') { text=baselineFns.replace(/export const beta =[\s\S]*?\);\n/,''); expected={alpha:base.alpha,gamma:base.gamma}; removed=['beta']; }
          if(kind==='body') { text=baselineFns.replace('alpha-public','alpha-updated'); expected={...base,alpha:'alpha-updated'}; }
          const intermediate=kind==='add'?text.replaceAll('delta','temporary'):kind==='rename'?text.replaceAll('renamed','temporary'):kind==='remove'?baselineFns.replace(/export const gamma =[\s\S]*?\);\n/,''):text.replace('alpha-updated','alpha-intermediate');
          await edit(`${kind}-${suffix}`,'src/functions.ts',rapid?intermediate:text,expected,'Public leaf baseline',removed,rapid?text:undefined,true);
          await edit(`revert-${kind}-${suffix}`,'src/functions.ts',baselineFns,base,'Public leaf baseline',[],undefined,true);
        }
      }
      step='revert'; lastEvent=now(); peak=process.memoryUsage().rss;
      fs.unlinkSync('src/routes/extra.tsx'); fs.writeFileSync('src/Leaf.tsx',baselineLeaf);
      await waitIdle(2); await sample(base,'Public leaf baseline');
      }
    }
  }
  fs.writeFileSync(path.join(out,'success.json'),JSON.stringify({passed:true,arm,scenario,steps:checks.length}));
} catch(error) {
  console.error(error); process.exitCode=1;
} finally {
  clearInterval(timer);
  fs.writeFileSync(path.join(out,'events.json'),JSON.stringify(events,null,2));
  fs.writeFileSync(path.join(out,'builds.json'),JSON.stringify(builds,null,2));
  if(server?.close) await server.close();
  else if(server?.server?.close) await server.server.close();
}

process.exit(process.exitCode || 0);
