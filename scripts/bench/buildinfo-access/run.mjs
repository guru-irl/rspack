import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const [coreFile, version, scenario, access, record] = process.argv.slice(2);
const root = path.resolve(process.env.BUILDINFO_BENCH_DIR || '.bench/buildinfo-access');
const fixtureInfo = JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8'));
const fixture = path.join(root, 'fixture');
const require = createRequire(import.meta.url);
const { rspack } = await import(pathToFileURL(coreFile));
const cacheDir = path.join(root, 'caches', `${version}-${scenario}-${access}`);
const outputDir = path.join(root, 'output');
const ns = () => process.hrtime.bigint();
const ms = (a,b) => Number(b-a)/1e6;
const anon = () => Number(/^RssAnon:\s+(\d+)/m.exec(fs.readFileSync('/proc/self/status','utf8'))[1]);
let finishStart, current, started, cpuStart;
const results = [];
fs.writeFileSync(record+'.events','');
const event = (name,stage) => fs.appendFileSync(record+'.events', JSON.stringify({name,stage,timeNs:ns().toString()})+'\n');
const plugin = { apply(compiler) {
  compiler.hooks.finishMake.tap('SyntheticBuildInfoAccess', compilation => {
    event('tap-start',results.length);
    finishStart = ns();
    let count = 0, modules = 0;
    for (const m of compilation.modules) {
      modules++;
      if (access === 'read') {
        const v = m.buildInfo['x.custom.key'];
        if (v) count++;
      }
    }
    const tapEnd = ns();
    event('tap-end',results.length);
    current = { modules, customCount: access === 'read' ? count : null, tapMs: ms(finishStart,tapEnd), tapEndRssAnonKiB:anon(), loaderCalls:global.__fixtureLoaderCalls || 0 };
    if (modules !== fixtureInfo.modules) throw new Error(`Unexpected modules ${modules}`);
    if (access === 'read' && count !== fixtureInfo.customCount) throw new Error(`Unexpected custom count ${count}`);
  });
  compiler.hooks.afterCompile.tap('SyntheticBuildInfoAccess', () => { current.finishMakeAfterCompileMs = ms(finishStart, ns()); });
  compiler.hooks.done.tap('SyntheticBuildInfoAccess', () => {
    const cpu = process.cpuUsage(cpuStart);
    current.compilerWallMs = ms(started,ns());
    current.cpuUserMs = cpu.user/1000; current.cpuSysMs=cpu.system/1000;
    current.endRssAnonKiB = anon();
    event('done',results.length);
  });
}};
const config = { context:fixture, mode:'development', target:'node', entry:'./src/index.js', devtool:false,
  output:{path:outputDir,filename:'bundle.cjs',library:{type:'commonjs2'}},
  optimization:{minimize:false,moduleIds:'named',chunkIds:'named',concatenateModules:false},
  module:{rules:[{test:/m\d+\.js$/,use:[{loader:path.join(fixture,'loader.cjs')}]}]},
  plugins:[plugin], stats:'errors-only', experiments:{newCache:scenario === 'new'},
  cache: scenario === 'cold' || scenario === 'watch' ? false : {type:'persistent',storage:{type:'filesystem',directory:cacheDir},buildDependencies:[path.join(fixture,'loader.cjs')]},
};
const compiler = rspack(config);
function start() { global.__fixtureLoaderCalls=0; started=ns();cpuStart=process.cpuUsage(); event('start',results.length); }
function check(err,stats) {
  if(err) throw err;
  if(stats.hasErrors()) throw new Error(stats.toString({all:false,errors:true}));
  const file=path.join(outputDir,'bundle.cjs');
  current.sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  delete require.cache[require.resolve(file)];
  current.outputValue=require(file);
  if (current.outputValue !== fixtureInfo.expectedValue) throw new Error(`Output ${current.outputValue}`);
  results.push(current);
}
if(scenario==='watch') {
  let turn=0;
  const changed=path.join(fixture,'src/g000/m00000.js');
  const original=fs.readFileSync(changed,'utf8');
  start();
  await new Promise((resolve,reject) => {
    const watching = compiler.watch({aggregateTimeout:0}, (err,stats) => {
      try { check(err,stats); }
      catch (e) { watching.close(()=>reject(e));return; }
      if(turn++===0) {
        start();
        // Semantically unchanged but content-invalidating edit; one real watch rebuild.
        fs.writeFileSync(changed,original+'// rebuild\n');
      } else {
        watching.close(e=>{fs.writeFileSync(changed,original); e?reject(e):resolve();});
      }
    });
  });
} else {
  start();
  await new Promise((resolve,reject)=>compiler.run((err,stats)=>{try{check(err,stats);resolve();}catch(e){reject(e);}}));
}
await new Promise((resolve,reject)=>compiler.close(err=>err?reject(err):resolve()));
const recordData={version,scenario,access,results,closeEndRssAnonKiB:anon(),nodeVersion:process.version};
fs.writeFileSync(record,JSON.stringify(recordData,null,2)+'\n');
console.log(JSON.stringify(recordData));
