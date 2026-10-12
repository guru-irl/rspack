import { triggerCapture } from './trigger-capture.mjs';
import { recordRestartShutdown } from './restart-shutdown.mjs';
import fs from 'node:fs';
import { runtimeCSS } from './runtime-css.mjs';
import { createServer } from 'node:http';
import { NodeRequest, sendNodeResponse } from 'srvx/node';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/rsbuild';
const out = process.env.RESULT_DIR;
const arm = process.env.ARM;
const scenario = process.env.SCENARIO || 'correctness';
const compilerNames=process.env.COMPILER_COUNT==='4'?['client','ssr','aux-a','aux-b']:['client','ssr'];
const userEdges=process.env.USER_EDGES || '';
const measuring=scenario.startsWith('warm-')||scenario==='cold-measure';
const customWindow=scenario==='r3-custom-request';
const restartShutdown=scenario==='r2-restart'?recordRestartShutdown(path.join(out,'restart-shutdown.json')):undefined;
const coldCloseTrigger=process.env.MODE==='r3-restart-diagnosis'&&['stock','gate-only'].includes(arm)?'client-finishMake':'ssr-watchRun';
const requestWindowEnabled=customWindow||scenario==='r3-request'||scenario==='correctness';
let windowRequest;
let windowEvidence;
fs.mkdirSync(out, { recursive: true });
const now = () => performance.now();
const pause = ms => new Promise(r => setTimeout(r, ms));
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const resolver = id => id.includes('_tanstack-start-server-fn-resolver.js');
const deletionRequests=[];
const pendingDeletionRequests=[];
let step = 'initial';
let lastEvent = now();
let peak = process.memoryUsage().rss;
const active = new Set();
const pendingInvalid = new Set();
const freshnessChecks = [];
let preEditAssets = new Map();
const builds = [];
const events = [];
const checks = [];
const current = new Map();
const compilers = new Map();
const triggers=triggerCapture({step:()=>step,now,normalize:p=>normalize(p)});
const timer = measuring ? undefined : setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
const event = (name, kind, extra = {}) => { const t = now(); lastEvent = t; events.push({ step, name, kind, t, wallMs:Date.now(), ...extra }); };
const normalize = s => s.replaceAll(process.cwd(), '<APP>').replaceAll('\\', '/');
const startPlugin=tanstackStart();
assert.equal(startPlugin.name,'tanstack-start-rsbuild');
const originalSetup=startPlugin.setup;
startPlugin.setup=(api)=>{
 const registrations=[];
 const processAssets=api.processAssets.bind(api);
 api.processAssets=(options,callback)=>{registrations.push({options,source:Function.prototype.toString.call(callback)});return processAssets(options,callback);};
 originalSetup(api);
 api.onAfterCreateCompiler(()=>{
  const matched=registrations.filter(({options})=>Object.keys(options).length===2&&options.stage==='report'&&JSON.stringify(options.environments)==='["client"]');
  assert.equal(matched.length,1,'exactly one client report capture registration');
  fs.writeFileSync(path.join(out,'plugin-capture.json'),JSON.stringify({pluginName:startPlugin.name,registrations:matched},null,2));
 });
};
const probe = { name: 'watch-observer', setup(api) {
  api.onAfterCreateCompiler(({compiler})=>triggers.setGraph(compiler));
  api.onBeforeStartDevServer(({server})=>{hookEnvironment=server.environments.ssr;});

  api.modifyRspackConfig((config, { environment }) => {
    config.devtool = false;
    if(scenario==='r2-topology'&&environment.name==='ssr')config.dependencies=['client'];
    if(requestWindowEnabled && environment.name==='client') {
      const entry=config.entry.index;
      config.entry.index=typeof entry==='string'||Array.isArray(entry)?{import:[...[entry].flat(),customWindow?'./aux/request-entry.js':'./aux/request.css']}:{...entry,import:[...[entry.import].flat(),customWindow?'./aux/request-entry.js':'./aux/request.css']};
    }
    if(scenario==='no-resolver' && environment.name==='ssr') {config.entry={index:{import:['./src/no-resolver.ts']}};}
    config.plugins.push({ apply(compiler) {
      compilers.set(environment.name,compiler);
      triggers.install(compiler,environment.name);
      compiler.hooks.invalid.tap('WatchInvalidObserver',()=>{pendingInvalid.add(environment.name);event(environment.name,'invalid');});
      compiler.hooks.watchRun.tap({ name: 'WatchObserver', stage: -10000 }, () => {
        pendingInvalid.delete(environment.name);active.add(environment.name); event(environment.name, 'watchRun');
      });
      if(['r2-close','r2-restart'].includes(scenario) && environment.name==='client') compiler.hooks.finishMake.tapPromise({name:'ColdCloseWindow',stage:900},async()=>{
        if(coldCloseTrigger==='client-finishMake') {event('client','coldCloseTrigger',{trigger:coldCloseTrigger});closeRequested=true;}
        while(!closeRequested)await pause(5);await pause(250);
      });
      if(scenario==='r2-done' && environment.name==='client') compiler.hooks.done.tapPromise({name:'DoneBarrierWindow',stage:15000},async()=>pause(250));
      if(scenario==='r2-child' && environment.name==='client') compiler.hooks.make.tapPromise({name:'ClientChild',stage:-5000},async(compilation)=>{
        const child=compilation.createChildCompiler('generic-child',{},[]);
        child.hooks.finishMake.tap({name:'ChildFinish',stage:2000},()=>event('child','finishMake'));
        await new Promise((resolve,reject)=>child.runAsChild(err=>err?reject(err):resolve()));
        await pause(250);
      });
      compiler.hooks.afterDone.tap('WatchAfterDoneObserver',()=>event(environment.name,'afterDone'));
      compiler.hooks.make.tap({name:'WatchMakeObserver',stage:-10000},()=>event(environment.name,'make'));
      compiler.hooks.finishMake.tap({name:'WatchMakeObserver',stage:10000},()=>event(environment.name,'finishMake'));
      compiler.hooks.thisCompilation.tap('WatchObserver', compilation => {
        compilation.hooks.seal.tap('WatchSealObserver',()=>event(environment.name,'seal'));
        if(requestWindowEnabled && environment.name==='client') compilation.hooks.afterSeal.tapPromise({name:'RequestWindow',stage:-10000},async()=>{
          if(step!=='request-window'||windowRequest)return;
          windowEvidence={started:now(),invalidSeen:events.some(e=>e.step===step&&e.name==='client'&&e.kind==='invalid')};
          windowRequest=(async()=>{const r=await fetch(`http://localhost:${customWindow?3101:3100}/`,{signal:AbortSignal.timeout(15000)});const html=await r.text();windowEvidence.status=r.status;windowEvidence.latencyMs=now()-windowEvidence.started;windowEvidence.css=linkedAssets(html).filter(url=>/\.css(?:[?#]|$)/.test(url));windowEvidence.linked=linkedAssets(html);fs.writeFileSync(path.join(out,'request-window.html'),html);})();
          // Only the client is held. Stock's graph and v3's request gate wait;
          // v2's independent SSR bundle is otherwise immediately ready.
          await pause(750);
        });
        compilation.hooks.afterSeal.tap('WatchSealObserver',()=>event(environment.name,'afterSeal'));
        const record = { step, name: environment.name, trigger:triggers.latest(environment.name), rebuilt: [], built: [], errors: [], modules: {}, assets: [] };
        current.set(environment.name, record);
        const original = compilation.rebuildModule.bind(compilation);
        compilation.rebuildModule = (mod, cb) => { record.rebuilt.push(normalize(mod.identifier())); return original(mod, cb); };
        if(!measuring) compilation.hooks.succeedModule.tap('WatchObserver', mod => record.built.push(normalize(mod.identifier())));
        if(!measuring) compilation.hooks.finishModules.tap({ name: 'WatchObserver', stage: 10000 }, modules => {
          for (const mod of modules) {
            const id = normalize(mod.identifier());
            if (id.includes('<APP>/src/') || resolver(id)) record.modules[id] = normalize(String(mod.originalSource()?.source() ?? ''));
          }
        });
        if(!measuring) compilation.hooks.processAssets.tap({ name: 'WatchObserver', stage: 6000 }, () => {
          for(const asset of compilation.getAssets()) {if(asset.name==='assets/js/index.js') fs.writeFileSync(path.join(out,`${step}-client-entry.txt`),String(asset.source.source()));}
          const cssChunks = [...compilation.chunks].filter(chunk => [...chunk.files].some(file => file.endsWith('.css'))).map(chunk => ({ id: chunk.id }));
          record.runtimeCSS = [];
          record.assets = compilation.getAssets().filter(a => !a.name.includes('hot-update')).map(a => {
            const text = String(a.source.source());
            const runtime = a.name.endsWith('.js') ? runtimeCSS(text, cssChunks) : { mappings: [], normalized: text };
            if (environment.name === 'client') record.runtimeCSS.push(...runtime.mappings.map(mapping => ({ asset: a.name, mapping })));
            return { name: a.name, bytes: a.source.size(), hash: hash(a.source.buffer()), normalizedHash: hash(runtime.normalized) };
          }).sort((a,b) => a.name.localeCompare(b.name));
        });
      });
      compiler.hooks.done.tap({ name: 'WatchObserver', stage: 10000 }, stats => {
        const record = current.get(environment.name);
        record.ms = stats.endTime - stats.startTime;
        record.hash=stats.hash;
        record.errors = measuring ? (stats.hasErrors()?['compilation failed']:[]) : stats.toJson({ all: false, errors: true }).errors;
        record.generated = normalize(globalThis.__watchVirtualState?.generateCurrentResolverContent(true) ?? '');
        builds.push(record); pendingInvalid.delete(environment.name);active.delete(environment.name); event(environment.name, 'done', { ms: record.ms, errors: record.errors.length });
        if(scenario==='r2b-delete' && step.startsWith('delete-') && record.errors.length) {
          const request={step,triggerCompiler:environment.name,started:now(),triggerErrors:record.errors.map(e=>e.message)};
          pendingDeletionRequests.push((async()=>{
            try {const response=await fetch(`http://localhost:${customWindow?3101:3100}/`,{signal:AbortSignal.timeout(10000)});const html=await response.text();Object.assign(request,{status:response.status,lastGoodContent:html.includes('Public leaf baseline')&&html.includes('alpha-public'),errorPage:/module not found|internal server error|can't resolve/i.test(html),htmlSha256:hash(html)});}
            catch(e){request.error=String(e);}
            request.ended=now();deletionRequests.push(request);
          })());
        }
      });
      compiler.hooks.failed.tap('WatchObserver', error => { event(environment.name, 'failed', { error: String(error) }); });
    } });
  });
} };
const waitIdle = async (minimum = 0) => {
  const start = now();
  while (now() - start < 120000) {
    const relevant = events.filter(e => e.step === step);
    if(scenario==='no-resolver') assert.ok(relevant.filter(e=>e.kind==='done').length<20,`${step}: no repeated resolver invalidation loop`);
    if (!active.size && !pendingInvalid.size && [...compilers.values()].every(c=>!c.watching?.running && !c.watching?.invalid) && relevant.filter(e => e.kind === 'done').length >= minimum && now() - lastEvent >= 1000) return;
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
// A hash suffix can change on Watchpack replay without changing served bytes.
const logicalAsset = url => new URL(url,'http://localhost:3100').pathname.replace(/\.[0-9a-f]{8}(?=\.(?:css|js)$)/i,'');
const linkedAssets = html => [...new Set([
  ...[...html.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map(m=>m[1]),
  ...[...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(m=>m[1]),
].filter(url=>/\.(?:css|js)(?:[?#]|$)/.test(url)))].sort();
const routeAssets = route => {
  const manifest=globalThis.__TSS_DEV_START_MANIFEST__;
  assert.ok(manifest?.routes?.__root__ && manifest.routes[route],`${step} ${route}: settled route manifest`);
  const urls=new Set();
  const collect=value=>{
    if(typeof value==='string' && /\.(?:css|js)(?:[?#]|$)/.test(value))urls.add(value);
    else if(Array.isArray(value))value.forEach(collect);
    else if(value && typeof value==='object')Object.values(value).forEach(collect);
  };
  for(const id of ['__root__',route])collect(manifest.routes[id]);
  return [...urls].sort();
};
const beforeEdit = () => {
  preEditAssets=new Map((builds.filter(b=>b.name==='client').at(-1)?.assets||[]).map(a=>[logicalAsset('/'+a.name),a.hash]));
};
const assertFreshness = async (route,linked,label) => {
  await waitIdle();
  const expected=routeAssets(route);
  const logical=urls=>[...new Set(urls.map(logicalAsset))].sort();
  const evidence={step,route,label,linked,expected,expectedLogical:logical(expected),actualLogical:logical(linked),assets:[]};
  const save=()=>fs.writeFileSync(path.join(out,'freshness.json'),JSON.stringify(freshnessChecks,null,2));
  freshnessChecks.push(evidence);save();
  assert.deepEqual(evidence.actualLogical,evidence.expectedLogical,`${step} ${route}: page logical assets equal settled route manifest`);
  const settled=new Map();
  for(const url of expected) {
    const response=await fetch(new URL(url,'http://localhost:3100'));
    assert.equal(response.status,200,`${step}: settled asset ${url}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    const sha256=hash(bytes);
    const compiled=builds.filter(b=>b.name==='client').at(-1).assets.find(a=>'/'+a.name===new URL(url,'http://localhost:3100').pathname);
    if(compiled)assert.equal(sha256,compiled.hash,`${step}: settled server bytes equal compilation ${url}`);
    settled.set(logicalAsset(url),{url,sha256});
  }
  for(const url of linked) {
    const current=settled.get(logicalAsset(url));
    const response=await fetch(new URL(url,'http://localhost:3100'));
    const sha256=hash(Buffer.from(await response.arrayBuffer()));
    const previous=preEditAssets.get(logicalAsset(url));
    evidence.assets.push({url,logical:logicalAsset(url),status:response.status,sha256,settled:current.sha256,previous});save();
    assert.equal(response.status,200,`${step}: linked asset remains fetchable ${url}`);
    assert.equal(sha256,current.sha256,`${step}: linked asset has settled bytes ${url}`);
    if(previous && previous!==current.sha256)assert.notEqual(sha256,previous,`${step}: no pre-edit bytes ${url}`);
  }
  evidence.passed=true;save();
};
const sample = async (expected, leaf, removed = [], addedRoute = false) => {
  const responses = {};
  const pages = [];
  for (const route of measuring?['/']:['/', '/page-001', '/page-025', '/page-060', ...(addedRoute ? ['/extra'] : [])]) {
    const response = await fetch(`http://localhost:3100${route}`);
    const html = await response.text();
    assert.equal(response.status, 200, `${step} ${route}: SSR HTTP status, ${html.slice(0,300)}`);
    assert.ok(html.includes(leaf), `${step} ${route}: leaf content`);
    const pre = /<pre>([\s\S]*?)<\/pre>/.exec(html)?.[1];
    const data = JSON.parse(htmlDecode(pre ?? 'null'));
    assert.deepEqual(data, expected, `${step} ${route}: SSR data`);
    responses[route] = { status: response.status, data, leaf, css: [...html.matchAll(/<link[^>]+href="([^"]+\.css[^\"]*)"/g)].map(m => m[1]).sort(), scripts: [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).sort() };
    pages.push({route,linked:linkedAssets(html)});
    fs.writeFileSync(path.join(out, `${step}-${route.replaceAll('/', '_')}.html`), html);
  }
  for(const page of pages)await assertFreshness(page.route,page.linked,'checkpoint');
  await waitIdle();
  const latest = Object.fromEntries(compilerNames.map(name => [name, builds.filter(b => b.name === name).at(-1)]));
  if (!measuring) {
    const runtimeChecks = [];
    const save = () => fs.writeFileSync(path.join(out, `${step}-runtime-css.json`), JSON.stringify(runtimeChecks, null, 2));
    for (const { asset, mapping } of latest.client.runtimeCSS) for (const entry of mapping) {
      const evidence = { asset, ...entry };
      runtimeChecks.push(evidence); save();
      const compiled = latest.client.assets.find(a => a.name === entry.filename);
      assert.ok(compiled, `${step}: miniCssF CSS filename exists in settled client output: ${entry.filename}`);
      const logical = latest.client.assets.filter(a => logicalAsset('/' + a.name) === '/' + entry.logical);
      assert.equal(logical.length, 1, `${step}: unique settled logical CSS asset`);
      const response = await fetch(new URL(entry.filename, 'http://localhost:3100/'));
      evidence.status = response.status;
      evidence.sha256 = hash(Buffer.from(await response.arrayBuffer()));
      evidence.settled = logical[0].hash; save();
      assert.equal(response.status, 200, `${step}: runtime CSS HTTP 200 ${entry.filename}`);
      assert.equal(evidence.sha256, evidence.settled, `${step}: runtime CSS has settled bytes ${entry.filename}`);
      evidence.passed = true; save();
    }
  }
  assert.ok(latest.ssr && latest.client, `${step}: both output snapshots`);
  for (const [name,b] of Object.entries(latest)) assert.equal(b.errors.length,0,`${step}: ${name} final compile errors`);
  const compiled = measuring ? latest.ssr.generated : Object.entries(latest.ssr.modules).find(([id]) => resolver(id))?.[1];
  assert.equal(compiled, latest.ssr.generated, `${step}: compiled resolver matches final shared resolver`);
  const ids = {};
  for (const match of compiled.matchAll(/'([^']+)': \{\s*functionName: '([^']+)'/g)) ids[match[2].replace('_createServerFn_handler', '')] = match[1];
  const calls = {};
  for (const [name, value] of measuring?[]:Object.entries(expected)) {
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
  const timing = { clientPasses:builds.filter(b=>b.step===step&&b.name==='client').length, spanMs: Math.max(...ends.map(e => e.t)) - Math.min(...starts.map(e => e.t)), ...Object.fromEntries(compilerNames.map(name=>[`${name}Ms`,builds.filter(b=>b.step===step&&b.name===name).reduce((n,b)=>n+b.ms,0)])), clientMs: builds.filter(b => b.step === step && b.name === 'client').reduce((n,b)=>n+b.ms,0), ssrMs: builds.filter(b=>b.step===step&&b.name==='ssr').reduce((n,b)=>n+b.ms,0), peakRss: peak, postRss: process.memoryUsage().rss };
  const overlap = starts.some(c => c.name === 'client' && starts.some(s => s.name === 'ssr' && s.t >= c.t && s.t < ends.find(e => e.name==='client' && e.t > c.t)?.t));
  const snapshots = Object.fromEntries(Object.entries(latest).map(([name,b]) => [name, { modules: b.modules, assets: b.assets, runtimeCSS: b.runtimeCSS }]));
  fs.writeFileSync(path.join(out, `${step}-outputs.json`), JSON.stringify(snapshots, null, 2));
  const check = { step, responses, calls, removedCalls, timing, overlap, resolverRebuilds: builds.filter(b=>b.step===step).flatMap(b=>b.rebuilt).filter(resolver).length };
  checks.push(check); console.log('CHECK', JSON.stringify(check));
  fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
  if (scenario === 'red-overlap' && step === 'leaf-1') assert.ok(overlap, 'warm client and SSR must overlap');
  if (arm !== 'stock' && scenario !== 'red-recovery' && step.startsWith('leaf-')) assert.equal(check.resolverRebuilds, 0, 'leaf keeps resolver gate fast path');
};
const edit = async (name, file, content, expected, leaf='Public leaf baseline', removed=[], rapid, addedRoute=false) => {
  beforeEdit();step=name; peak=process.memoryUsage().rss; lastEvent=now();
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
let pageServer;
let hookEnvironment;

let readyTime;
const checkRequestWindow=async()=>{
  const previous=builds.filter(b=>b.name==='client').at(-1).assets.filter(a=>a.name.endsWith('.css')).map(a=>'/'+a.name).sort();
  if(!customWindow)assert.ok(previous.length,'client-only CSS entry exists');
  beforeEdit();step='request-window';lastEvent=now();
  if(customWindow)fs.writeFileSync('aux/request-entry.js',"import './new-request.css';\n");
  else fs.writeFileSync('aux/request.css','.generic-request { color: rgb(80, 80, 80); }\n');
  await waitIdle(1);assert.ok(windowRequest,'request issued during client compilation');await windowRequest;
  const next=builds.filter(b=>b.name==='client').at(-1).assets.filter(a=>a.name.endsWith('.css')).map(a=>'/'+a.name).sort();
  const expectedCSS=routeAssets('/').filter(url=>/\.css(?:[?#]|$)/.test(url));
  Object.assign(windowEvidence,{previousCSS:previous,newCSS:next,expectedCSS,ssrPasses:builds.filter(b=>b.step===step&&b.name==='ssr').length});
  fs.writeFileSync(path.join(out,'request-window.json'),JSON.stringify(windowEvidence,null,2));
  assert.ok(windowEvidence.invalidSeen,'request follows client invalid');
  if(customWindow)assert.ok(next.some(url=>!previous.includes(url)),'client-only edit emits a NEW CSS asset');
  else assert.notDeepEqual(next,previous,'client-only CSS edit changes asset hash');
  assert.equal(windowEvidence.status,200,'window request succeeds');
  assert.ok(expectedCSS.some(url=>!previous.includes(url)),'settled route manifest requires the NEW CSS asset');
  if(customWindow)assert.ok(expectedCSS.every(url=>windowEvidence.css.includes(url)),'window HTML references NEW CSS asset required by stock route manifest');
  await assertFreshness('/',windowEvidence.linked,'request-window');
};
let readiness;
let closeRequested=false;
const started=now();
try {
  const rsbuild = await createRsbuild({ config: { plugins:[pluginReact(),startPlugin,probe], environments:compilerNames.length===4?Object.fromEntries(['aux-a','aux-b'].map(name=>[name,{source:{entry:{index:`./aux/${name}.js`}},output:{target:'web',distPath:{root:`dist/${name}`}},tools:{htmlPlugin:false}}])):undefined, tools:{rspack(config,{environment}) {if(userEdges==='direct'&&environment.name==='ssr')config.dependencies=['client'];if(userEdges==='transitive'){if(environment.name==='ssr')config.dependencies=['aux-a'];if(environment.name==='aux-a')config.dependencies=['client'];}}}, output:requestWindowEnabled?{filename:customWindow?{js:'[name].js',css:'[name].css'}:{css:'[name].[contenthash:8].css'}}:undefined, performance:{buildCache:false}, server:{port:3100,strictPort:true,open:false} } });
  if(customWindow) {
    server=await rsbuild.createDevServer();
    assert.equal(server.environments.ssr,hookEnvironment,'createDevServer exposes the same SSR environment as the hook');
    fs.writeFileSync(path.join(out,'environment-identity.json'),JSON.stringify({passed:true}));
    await server.listen();
    pageServer=createServer(async(req,res)=>{
      try {
        const entry=(await server.environments.ssr.loadBundle('index')).default;
        const handler=typeof entry==='function'?entry:entry.fetch.bind(entry);
        await sendNodeResponse(res,await handler(new NodeRequest({req,res})));
      } catch(error) {console.error(error);res.statusCode=500;res.end(String(error));}
    });
    await new Promise(resolve=>pageServer.listen(3101,resolve));
  } else server=await rsbuild.startDevServer();
  if(['r2-close','r2-restart'].includes(scenario)) {
    const deadline=now()+10000;
    while(!events.some(e=>coldCloseTrigger==='client-finishMake'?e.name==='client'&&e.kind==='coldCloseTrigger':e.name==='ssr'&&e.kind==='watchRun')) {assert.ok(now()<deadline,`Cold close trigger reached: ${coldCloseTrigger}`);await pause(5);}
    console.log('[restart-window]',JSON.stringify({arm,pid:process.pid,trigger:coldCloseTrigger}));
    closeRequested=true;
    await Promise.race([restartShutdown?restartShutdown.restart(()=>server.close ? server.close() : server.server.close()):(server.close ? server.close() : server.server.close()),pause(5000).then(()=>{throw new Error('server.close did not resolve during the cold barrier')})]);
    server=undefined;
    if(scenario==='r2-restart') {
      closeRequested=true;active.clear();step='restart';lastEvent=now();
      server=await rsbuild.startDevServer();await waitIdle(2);
      await sample(base,'Public leaf baseline');await restartShutdown.final(()=>server.close ? server.close() : server.server.close());server=undefined;
    }
    fs.writeFileSync(path.join(out,'success.json'),JSON.stringify({passed:true,arm,scenario,closed:true}));
    clearInterval(timer);fs.writeFileSync(path.join(out,'pass-triggers.json'),JSON.stringify(triggers.evidence(),null,2));
    fs.writeFileSync(path.join(out,'events.json'),JSON.stringify(events));process.exit(0);
  }
  readiness=(async()=>{
    if(scenario==='no-resolver') {readyTime=now();return;}
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
  if(scenario==='no-resolver') {assert.ok(builds.filter(b=>b.name==='ssr').every(b=>!Object.keys(b.modules).some(resolver)),'custom SSR entry has no resolver');}
  else await sample(base,'Public leaf baseline');
  const cold={ ssrReadyMs: readyTime-started, firstSsrDoneMs:events.find(e=>e.name==='ssr'&&e.kind==='done').t-started, finalReadyMs: events.filter(e=>e.kind==='done').at(-1).t-started, peakRss:peak, arm };
  fs.writeFileSync(path.join(out,'cold.json'),JSON.stringify(cold,null,2));
  if(scenario==='r2b-delete') {
    const route=`import { createFileRoute } from '@tanstack/react-router';\nimport * as functions from '../functions';\nimport { Page } from '../Page';\nexport const Route = createFileRoute('/extra')({ loader:async()=>Object.fromEntries(await Promise.all(Object.entries(functions).sort(([a],[b])=>a.localeCompare(b)).map(async([name,fn])=>[name,await fn()]))), component: () => <Page title="Extra route" /> });\n`;
    for(let i=1;i<=3;i++) {
      await edit(`add-delete-${i}`,'src/routes/extra.tsx',route,base,undefined,[],undefined,true);
      step=`delete-${i}`;lastEvent=now();fs.unlinkSync('src/routes/extra.tsx');
      await waitIdle(2);await sample(base,'Public leaf baseline');
      await Promise.all(pendingDeletionRequests);
    }
    fs.writeFileSync(path.join(out,'deletion-requests.json'),JSON.stringify({arm,deletions:3,requests:deletionRequests,errorPasses:builds.filter(b=>b.step.startsWith('delete-')&&b.errors.length).map(b=>({step:b.step,name:b.name,errors:b.errors.map(e=>e.message)}))},null,2));
  } else if(scenario==='no-resolver') {
    const file='src/no-resolver.ts';
    const empty=fs.readFileSync(file,'utf8');
    const imported="import {getServerFnById} from '#tanstack-start-server-fn-resolver';\nexport default {fetch:async()=>new Response(String(getServerFnById))};\n";
    const checkResolver=(present,extra=false)=>{
      const last=builds.filter(b=>b.name==='ssr').at(-1);
      const compiled=Object.entries(last.modules).find(([id])=>resolver(id))?.[1];
      assert.equal(compiled!==undefined,present,`${step}: resolver import presence`);
      assert.equal(last.errors.length,0,`${step}: SSR compile errors`);
      if(present) {assert.equal(compiled,last.generated,`${step}: current compiled resolver`);if(extra)assert.ok(compiled.includes('delta_createServerFn_handler'),'re-added resolver includes current function discovery');}
    };
    const saveEntry=async(name,text,present)=>{step=name;lastEvent=now();fs.writeFileSync(file,text);await waitIdle(1);checkResolver(present);};
    await saveEntry('resolver-first-import',imported,true);
    await saveEntry('resolver-stop-import',empty,false);
    step='resolver-absent-function-edit';lastEvent=now();
    fs.writeFileSync('src/functions.ts',baselineFns+"\nexport const delta=createServerFn({method:'GET'}).handler(async()=> 'delta-public');\n");
    await waitIdle(2);checkResolver(false);
    await saveEntry('resolver-readd-import',imported,true);checkResolver(true,true);
  } else if (['r3-request','r3-custom-request'].includes(scenario)) {
    await checkRequestWindow();
  } else if (scenario==='red-after-make') {
    const e=events.filter(e=>e.step==='initial');
    const clientFinish=e.find(x=>x.name==='client'&&x.kind==='finishMake').t;
    const clientDone=e.find(x=>x.name==='client'&&x.kind==='done').t;
    const ssrMake=e.find(x=>x.name==='ssr'&&x.kind==='make').t;
    assert.ok(ssrMake>=clientFinish && ssrMake<clientDone,'after-make starts SSR make between client finishMake and done');
  } else if (scenario==='r2-child') {
    const childFinish=events.find(e=>e.name==='child'&&e.kind==='finishMake');
    const parentFinish=events.find(e=>e.name==='client'&&e.kind==='finishMake');
    const ssrMake=events.find(e=>e.name==='ssr'&&e.kind==='make');
    assert.ok(childFinish.t<parentFinish.t,'child finishMake was exercised before parent');
    assert.ok(ssrMake.t>=parentFinish.t,'child finishMake must not release after-make');
  } else if (scenario==='r2-done') {
    const clientAfter=events.find(e=>e.name==='client'&&e.kind==='afterDone');
    const ssrMake=events.find(e=>e.name==='ssr'&&e.kind==='make');
    assert.ok(ssrMake.t>=clientAfter.t,'default SSR make must wait for client afterDone');
  } else if (scenario==='r2-passes') {
    await edit('body-single','src/functions.ts',baselineFns.replace('alpha-public','alpha-updated'),{...base,alpha:'alpha-updated'});
    assert.equal(builds.filter(b=>b.name==='ssr'&&b.step==='body-single').length,1,'server-function body edit has one SSR pass');
    await edit('add-single','src/functions.ts',baselineFns+"\nexport const delta=createServerFn({method:'GET'}).handler(async()=> 'delta-public');\n",{...base,delta:'delta-public'});
    assert.equal(builds.filter(b=>b.name==='ssr'&&b.step==='add-single').length,1,'server-function add has one SSR pass');
  } else if (scenario==='cold'||scenario==='cold-measure'||scenario==='r2-topology') {}
  else if (scenario==='red-recovery') {
    step='resolver-recovery'; peak=process.memoryUsage().rss; lastEvent=now();
    globalThis.__watchVirtualState.tryUpdateServerFnResolver('export async function getServerFnById() { throw new Error("stale resolver") }\n');
    compilers.get('ssr').watching.invalidateWithChangesAndRemovals(new Set([globalThis.__watchVirtualState.serverFnResolverPath]),new Set());
    await waitIdle(1); await sample(base,'Public leaf baseline');
  } else if(scenario==='r2-read') {
    step='resolver-snapshot-read';lastEvent=now();
    const compiler=compilers.get('ssr');let captured=false;
    compiler.hooks.thisCompilation.tap('ReadBoundary',(compilation)=>{
      const rebuild=compilation.rebuildModule.bind(compilation);
      compilation.rebuildModule=(module,callback)=>{
        if(!resolver(module.identifier())||captured)return rebuild(module,callback);
        captured=true;
        globalThis.__watchVirtualState.tryUpdateServerFnResolver('export async function getServerFnById(){throw new Error("between snapshot and read")}\n');
        return rebuild(module,callback);
      };
    });
    globalThis.__watchVirtualState.tryUpdateServerFnResolver('export async function getServerFnById(){throw new Error("trigger read boundary")}\n');
    compiler.watching.invalidateWithChangesAndRemovals(new Set([globalThis.__watchVirtualState.serverFnResolverPath]),new Set());
    await waitIdle(1);assert.ok(captured,'write between snapshot and read exercised');await sample(base,'Public leaf baseline');
  } else if(scenario==='red-aba') {
    step='resolver-aba'; lastEvent=now(); peak=process.memoryUsage().rss;
    const compiler=compilers.get('ssr');
    let captured;
    compiler.hooks.thisCompilation.tap('AbaRebuildBoundary',(compilation)=>{
      const rebuild=compilation.rebuildModule.bind(compilation);
      compilation.rebuildModule=(module,callback)=>{
        if(!resolver(module.identifier()) || captured) return rebuild(module,callback);
        captured=true;
        const state=globalThis.__watchVirtualState;
        const content=state.generateCurrentResolverContent(true);
        state.tryUpdateServerFnResolver('export async function getServerFnById() { throw new Error("ABA stale resolver") }\n');
        return rebuild(module,(err)=>{state.tryUpdateServerFnResolver(content);callback(err);});
      };
    });
    globalThis.__watchVirtualState.tryUpdateServerFnResolver('export async function getServerFnById() { throw new Error("trigger resolver build") }\n');
    compiler.watching.invalidateWithChangesAndRemovals(new Set([globalThis.__watchVirtualState.serverFnResolverPath]),new Set());
    await waitIdle(1);
    assert.ok(captured,'C -> C-prime -> C race exercised across the real resolver rebuild');
    await sample(base,'Public leaf baseline');
  } else {
    const edits=scenario==='warm'||measuring?10:scenario==='red-overlap'?1:2;
    for(let i=1;i<=edits;i++) {
      if(scenario==='warm-body') await edit(`body-${i}`,'src/functions.ts',i%2?baselineFns.replace('alpha-public','alpha-updated'):baselineFns,i%2?{...base,alpha:'alpha-updated'}:base);
      else await edit(`leaf-${i}`,'src/Leaf.tsx',i%2?baselineLeaf.replace('baseline','changed'):baselineLeaf,base,i%2?'Public leaf changed':'Public leaf baseline');
    }
    if(scenario==='correctness' || scenario==='aa-route') {
      const route=`import { createFileRoute } from '@tanstack/react-router';\nimport * as functions from '../functions';\nimport { Page } from '../Page';\nexport const Route = createFileRoute('/extra')({ loader:async()=>Object.fromEntries(await Promise.all(Object.entries(functions).sort(([a],[b])=>a.localeCompare(b)).map(async([name,fn])=>[name,await fn()]))), component: () => <Page title="Extra route" /> });\n`;
      await edit('lazy-route','src/routes/extra.tsx',route,base,undefined,[],undefined,true);
      if(scenario!=='aa-route') {
      await edit('css-import','src/Leaf.tsx',`import './extra.css';\n${baselineLeaf}`,base,undefined,[],undefined,true);
      await checkRequestWindow();
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
  if(pageServer)await new Promise(resolve=>pageServer.close(resolve));
  fs.writeFileSync(path.join(out,'pass-triggers.json'),JSON.stringify(triggers.evidence(),null,2));
  fs.writeFileSync(path.join(out,'events.json'),JSON.stringify(events,null,2));
  fs.writeFileSync(path.join(out,'builds.json'),JSON.stringify(builds,null,2));
  if(['r2-close','r2-restart'].includes(scenario)&&closeRequested) {process.exit(process.exitCode||1);}
  if(server?.close) await (server.close ? server.close() : server.server.close());
  else if(server?.server?.close) await server.server.close();
}

process.exit(process.exitCode || 0);
