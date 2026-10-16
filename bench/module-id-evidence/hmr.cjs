'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {performance}=require('node:perf_hooks');
const root=__dirname;
const data=path.join(root,'data');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if(!process.env.HMR_ARM){
  const hashes=JSON.parse(fs.readFileSync(path.join(root,'build/identity.json')));
  if(hashes.base===hashes.pr)throw Error('Identical native arms');
  for(const arm of ['base','pr']){
    const native=path.join(root,'build',arm,'rspack.linux-x64-gnu.node');
    if(sha(native)!==hashes[arm])throw Error('Native file mismatch');
    const child=spawnSync(process.execPath,[__filename],{env:{...process.env,HMR_ARM:arm,NAPI_RS_NATIVE_LIBRARY_PATH:native,EXPECTED_NATIVE_SHA:hashes[arm]},stdio:'inherit',timeout:420000});
    if(child.error||child.status!==0)throw Error(`HMR ${arm} failed: ${child.error||child.status}`);
  }
}else{
  main().catch(e=>{console.error(e.stack);process.exitCode=1;});
}
async function main(){
  const arm=process.env.HMR_ARM;
  const native=fs.realpathSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
  const expected=process.env.EXPECTED_NATIVE_SHA;
  if(sha(native)!==expected)throw Error('Native identity mismatch before import');
  const oldDlopen=process.dlopen;
  let loads=0;
  process.dlopen=function(module,filename,...args){
    if(filename.endsWith('.node')){
      if(fs.realpathSync(filename)!==native||sha(filename)!==expected)throw Error('Unexpected loaded native');
      loads++;
    }
    return oldDlopen.call(this,module,filename,...args);
  };
  const {rspack}=require(path.join(root,'../../packages/rspack/dist/index.js'));
  if(loads!==1)throw Error('Missing native identity verification');
  const devServerUrl=pathToFileURL(require.resolve('@rspack/dev-server',{paths:[path.join(root,'../../packages/rspack-cli')]})).href;
  const {RspackDevServer}=await import(devServerUrl);
  const {chromium}=require(path.join(root,'toolchain/node_modules/playwright'));
  const {h64}=require(require.resolve('xxhashjs',{paths:[path.join(root,'../../tests/rspack-test')]}));
  const fixture=path.join(root,'hmr-fixture');
  fs.mkdirSync(path.join(fixture,'src'),{recursive:true});
  fs.mkdirSync(path.join(fixture,'public'),{recursive:true});
  const component=(i,edit=0)=>`export default function Component${i}(props) { return <section data-index={${i}} data-edit={${edit}}><h2>Component ${i}</h2><span>{props.value}</span></section>; }\n`;
  const file=i=>`Component${String(i).padStart(5,'0')}.jsx`;
  for(let i=0;i<10000;i++)fs.writeFileSync(path.join(fixture,'src',file(i)),component(i));
  const targetSource="export const value = 'old'; if(module.hot) module.hot.dispose(()=>{globalThis.removedDisposed=(globalThis.removedDisposed||0)+1;});\n";
  fs.writeFileSync(path.join(fixture,'module7.js'),targetSource);
  function entry(renameFile='module7.js'){
    const imports=[`import {value as renameValue} from './${renameFile}';`],names=[];
    for(let i=0;i<10000;i++){imports.push(`import C${i} from './src/${file(i)}';`);names.push(`C${i}`);}
    for(let i=0;i<9000;i++){imports.push(`import Q${i} from './src/${file(i)}?variant';`);names.push(`Q${i}`);}
    return imports.join('\n')+`\nglobalThis.components=[${names.join(',')}];\nglobalThis.renameValue=renameValue;\nglobalThis.contentRevision=C0({value:'x'}).props['data-edit'];\nglobalThis.queryRevision=Q0({value:'x'}).props['data-edit'];\nglobalThis.entryExecutions=(globalThis.entryExecutions||0)+1;\nif(module.hot){module.hot.accept();module.hot.accept(['./src/${file(0)}','./src/${file(0)}?variant'],()=>{globalThis.contentRevision=C0({value:'x'}).props['data-edit'];globalThis.queryRevision=Q0({value:'x'}).props['data-edit'];globalThis.acceptCount=(globalThis.acceptCount||0)+1;});}\n`;
  }
  fs.writeFileSync(path.join(fixture,'index.jsx'),entry());
  fs.writeFileSync(path.join(fixture,'public/index.html'),'<!doctype html><html><body><script src="/main.js"></script></body></html>');
  let progressEvents=0;
  const compiler=rspack({context:fixture,mode:'development',target:'web',devtool:false,entry:'./index.jsx',cache:true,resolve:{modules:[path.join(root,'toolchain/node_modules'),'node_modules']},output:{path:path.join(root,'hmr-output'),filename:'main.js',publicPath:'/'},optimization:{moduleIds:'compact-hashed',chunkIds:'named',minimize:false,concatenateModules:false},plugins:[new rspack.ProgressPlugin(()=>{progressEvents++;})],module:{rules:[{test:/\.jsx$/,use:{loader:'builtin:swc-loader',options:{jsc:{target:'es2020',parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'automatic',development:true}}}}}}]},watchOptions:{aggregateTimeout:150},infrastructureLogging:{level:'error'}});
  let start=0,waiter=null;
  const completed=[];
  const summaries=[];
  const fatalErrors=[];
  compiler.hooks.invalid.tap('EvidenceTrace',filename=>console.log(JSON.stringify({event:'invalid',filename})));
  compiler.hooks.watchRun.tap('EvidenceClock',()=>{start=performance.now();console.log(JSON.stringify({event:'watchRun',modified:[...(compiler.modifiedFiles||[])],removed:[...(compiler.removedFiles||[])]}));});
  compiler.hooks.done.tap('EvidenceStats',stats=>{
    const elapsedMs=performance.now()-start;
    if(stats.hasErrors()){const e=Error(stats.toString({all:false,errors:true}));fatalErrors.push(e);if(waiter){waiter.reject(e);waiter=null;}return;}
    const item={stats,elapsedMs};completed.push(item);
    console.log(JSON.stringify({event:'done',number:completed.length,hash:stats.hash,elapsedMs,modified:[...(compiler.modifiedFiles||[])],removed:[...(compiler.removedFiles||[])]}));
    if(waiter){waiter.resolve(item);waiter=null;}
  });
  function nextCompilation(){
    if(waiter)throw Error('Concurrent compilation waiter');
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waiter=null;reject(Error('Dev-server compilation timeout'));},120000);
      waiter={resolve:x=>{clearTimeout(timer);resolve(x);},reject:e=>{clearTimeout(timer);reject(e);}};
    });
  }
  function snapshot(item,label){
    const json=item.stats.toJson({all:false,ids:true,modules:true,cachedModules:true,runtimeModules:true,nestedModules:true,groupModulesByAttributes:false,groupModulesByCacheStatus:false,groupModulesByExtension:false,groupModulesByLayer:false,groupModulesByPath:false,groupModulesByType:false,groupModulesByEmitStatus:false});
    const flatten=ms=>(ms||[]).flatMap(m=>[m,...flatten(m.modules),...flatten(m.children)]);
    const modules=flatten(json.modules).filter(m=>m.identifier&&m.moduleType!=='runtime'&&m.id!==null&&m.id!==undefined);
    const ids=new Map(modules.map(m=>[m.identifier,String(m.id)]));
    if(new Set(ids.values()).size!==ids.size)throw Error('Duplicate module IDs');
    const generated=modules.filter(m=>m.codeGenerated);
    const assets=item.stats.compilation.getAssets().map(a=>a.name);
    const record={label,elapsedMs:item.elapsedMs,modules:modules.length,codeGenerated:generated.length,processedFixtureModules:generated.filter(m=>m.identifier.split('!').pop().startsWith(fixture)).map(m=>m.name),assets,hash:item.stats.hash,progressEvents};
    summaries.push(record);
    fs.writeFileSync(path.join(data,`hmr-${arm}-${label}-ids.json`),JSON.stringify([...ids]));
    return {record,ids,generated};
  }
  const server=new RspackDevServer({host:'127.0.0.1',port:0,hot:true,liveReload:false,static:{directory:path.join(fixture,'public'),watch:false},client:{overlay:false,logging:'error'},devMiddleware:{stats:false}},compiler);
  let browser;
  try{
    const first=nextCompilation();
    await server.start();
    const initial=snapshot(await first,'initial');
    const address=server.server.address();
    const origin=`http://127.0.0.1:${address.port}`;
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage();
    const pageErrors=[];
    page.on('pageerror',e=>pageErrors.push(String(e)));
    await page.addInitScript(()=>{sessionStorage.navigations=String(Number(sessionStorage.navigations||0)+1);});
    await page.goto(origin,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>globalThis.contentRevision===0&&globalThis.queryRevision===0&&globalThis.renameValue==='old');
    const beforeProgress=progressEvents;
    const contentWait=nextCompilation();
    fs.writeFileSync(path.join(fixture,'src',file(0)),component(0,1));
    const content=snapshot(await contentWait,'content');
    const changed=[...initial.ids].filter(([key,id])=>content.ids.has(key)&&content.ids.get(key)!==id);
    if(changed.length)throw Error('Content edit changed existing IDs');
    if(progressEvents<=beforeProgress)throw Error('ProgressPlugin did not run on content edit');
    if(arm==='pr'){
      const allowed=new Set([path.join(fixture,'index.jsx'),path.join(fixture,'src',file(0)),path.join(fixture,'src',file(0))+'?variant']);
      if(content.generated.length<2||content.generated.some(m=>!allowed.has(m.identifier.split('!').pop())))throw Error('Content edit processed unrelated codegen modules');
    }else if(content.generated.length<19005)throw Error('Base did not exercise global codegen processing');
    async function manifests(snap){
      const names=snap.record.assets.filter(n=>n.endsWith('.hot-update.json'));
      if(!names.length||!snap.record.assets.some(n=>n.endsWith('.hot-update.js')))throw Error('Missing hot update assets');
      const out=[];
      for(const name of names){const response=await fetch(origin+'/'+name);if(!response.ok)throw Error('Hot manifest unavailable');out.push({name,manifest:await response.json()});}
      return out;
    }
    const contentManifests=await manifests(content);
    await page.waitForFunction(()=>globalThis.contentRevision===1&&globalThis.queryRevision===1&&globalThis.acceptCount>=1);
    if(await page.evaluate(()=>Number(sessionStorage.navigations))!==1)throw Error('Content edit reloaded page');
    const evidence={arm,nativeSha256:expected,nativeLoads:loads,contentIdsUnchanged:true,contentManifests,contentRuntime:await page.evaluate(()=>({contentRevision:globalThis.contentRevision,queryRevision:globalThis.queryRevision,acceptCount:globalThis.acceptCount,navigations:Number(sessionStorage.navigations)}))};
    if(arm==='pr'){
      const oldKey=path.join(fixture,'module7.js'),oldId=content.ids.get(oldKey);
      if(!oldId)throw Error('Rename target absent');
      const alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      function compact(name){let x=BigInt('0x'+h64(name,0).toString(16));let out=alphabet[Number(x%52n)];x/=52n;for(let i=1;i<11;i++){out+=alphabet[Number(x%62n)];x/=62n;}return out;}
      if(!compact('./module7.js').startsWith(oldId))throw Error('Unexpected compact hash input');
      const occupied=new Set(content.ids.values());
      for(let length=1;length<oldId.length;length++)if(!occupied.has(oldId.slice(0,length)))throw Error('Shorter collision prefix not reserved');
      let replacement;
      for(let i=0;i<2000000;i++){const name=`replacement${i}.js`;if(compact('./'+name).startsWith(oldId)){replacement=name;break;}}
      if(!replacement)throw Error('No colliding rename candidate');
      const renameWait=nextCompilation();
      fs.unlinkSync(oldKey);
      fs.writeFileSync(path.join(fixture,replacement),"export const value = 'new';\n");
      fs.writeFileSync(path.join(fixture,'index.jsx'),entry(replacement));
      const renamed=snapshot(await renameWait,'rename');
      const newId=renamed.ids.get(path.join(fixture,replacement));
      if(renamed.ids.has(oldKey)||!newId||newId===oldId)throw Error('Removed ID reused by rename');
      const renameManifests=await manifests(renamed);
      if(!renameManifests.some(m=>(m.manifest.m||[]).map(String).includes(oldId)))throw Error('Old ID absent from removed-module manifest');
      await page.waitForFunction(()=>globalThis.renameValue==='new'&&globalThis.removedDisposed===1&&globalThis.contentRevision===1&&globalThis.queryRevision===1);
      const runtime=await page.evaluate(()=>({renameValue:globalThis.renameValue,removedDisposed:globalThis.removedDisposed,contentRevision:globalThis.contentRevision,queryRevision:globalThis.queryRevision,entryExecutions:globalThis.entryExecutions,navigations:Number(sessionStorage.navigations)}));
      if(runtime.navigations!==1)throw Error('Rename reloaded page');
      evidence.rename={oldId,newId,replacement,fullHash:compact('./'+replacement),manifests:renameManifests,runtime};
    }
    if(pageErrors.length||fatalErrors.length)throw Error('Browser or compiler errors: '+pageErrors.join(';'));
    if(completed.length!==(arm==='pr'?3:2))throw Error('Unexpected extra filesystem rebuild');
    evidence.compilations=summaries;
    fs.writeFileSync(path.join(data,`hmr-${arm}.json`),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({arm,contentCodeGenerated:content.generated.length,progressEvents,contentIdsUnchanged:true,rename:evidence.rename||null}));
  }finally{
    if(browser)await browser.close();
    await server.stop();
    await new Promise((resolve,reject)=>compiler.close(e=>e?reject(e):resolve()));
  }
}
