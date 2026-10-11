const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const ROOT = process.env.IDS_RESULT_ROOT;
const SOURCE = path.join(ROOT, 'fixture');
const OUT = path.join(ROOT, 'output');
const arm = process.argv[2], block = +process.argv[3];
const core = require(path.join(process.env.IDS_CORE, 'dist/index.js'));
const routes = 240, leaves = 50;
fs.rmSync(SOURCE, {recursive:true, force:true});
fs.rmSync(OUT, {recursive:true, force:true});
fs.mkdirSync(SOURCE, {recursive:true});
function leaf(r, l, edit=0) {
 return `export const value = ${r*leaves+l}; export function render(x) { return x + value + ${JSON.stringify('public-value-'+ 'x'.repeat(edit*7))}; }\n`;
}
for (let r=0;r<routes;r++) {
 const dir=path.join(SOURCE, `route${r}`); fs.mkdirSync(dir);
 for(let l=0;l<leaves;l++) fs.writeFileSync(path.join(dir,`leaf${l}.js`),leaf(r,l));
 fs.writeFileSync(path.join(dir,'index.js'), Array.from({length:leaves},(_,l)=>`import {render as r${l}} from './leaf${l}.js';`).join('\n')+'\nexport default function render(x) { return ['+Array.from({length:leaves},(_,l)=>`r${l}(x)`).join(',')+']; }\n');
}
fs.writeFileSync(path.join(SOURCE,'index.js'), 'export const routes = ['+Array.from({length:routes},(_,r)=>`() => import('./route${r}/index.js')`).join(',')+'];\n');
const compiler=core.rspack({
 context: SOURCE, mode:'development', entry:'./index.js', cache:false, incremental:'advance', devtool:false,
 output:{path:OUT,filename:'[name].[contenthash].js',chunkFilename:'[name].[contenthash].js',clean:true,publicPath:'',library:{type:'commonjs2'}},
 optimization:{moduleIds:'deterministic',chunkIds:'deterministic',concatenateModules:false,inlineExports:false,mangleExports:false,usedExports:false,splitChunks:false,minimize:false},
 stats:{all:false,logging:'verbose',loggingDebug:[/rspack\.incremental/,/rspack\.Compilation/]},
});
const result={arm,block,routes,leaves,modules:routes*(leaves+1)+1,steps:[]};
let step=0, editStart=performance.now(), editStartEpoch=Date.now()/1000, watcher, failed=false;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function finish(error) {
 if(failed) return; failed=true;
 if(error) { console.error(error.stack||error); process.exitCode=1; }
 if(watcher) await new Promise(resolve=>watcher.close(resolve));
 await new Promise(resolve=>compiler.close(resolve));
 if(!error) fs.writeFileSync(path.join(ROOT,`run-${block}-${arm}.json`),JSON.stringify(result,null,2)+'\n');
}
watcher=compiler.watch({aggregateTimeout:10},async (error,stats)=>{
 const elapsed=performance.now()-editStart;
 const editEndEpoch=Date.now()/1000;
 try {
  if(error) throw error;
  if(stats.hasErrors()) throw new Error(stats.toString({all:false,errors:true,errorDetails:true}));
  const json=stats.toJson({all:false,errors:true,warnings:true,logging:'verbose',loggingDebug:[/rspack\.incremental/,/rspack\.Compilation/]});
  const assetDir=path.join(ROOT,'assets',`block${block}`,arm,`step${step}`);
  fs.mkdirSync(assetDir,{recursive:true});
  const assets={};
  for(const name of fs.readdirSync(OUT).sort()) {
   const bytes=fs.readFileSync(path.join(OUT,name));
   assets[name]=createHash('sha256').update(bytes).digest('hex');
   fs.writeFileSync(path.join(assetDir,name),bytes);
  }
  const logging={};
  for(const [name,group] of Object.entries(json.logging||{})) {
   logging[name]=(group.entries||[]).map(x=>({type:x.type,message:x.message}));
  }
  await wait(300);
  const proc=fs.readFileSync('/proc/self/status','utf8');
  const rssKb=Number(proc.match(/^VmRSS:\s+(\d+)/m)[1]);
  const peakKb=Number(proc.match(/^VmHWM:\s+(\d+)/m)[1]);
  result.steps.push({step,editStartEpoch,editEndEpoch,elapsedMs:elapsed,statsMs:stats.endTime-stats.startTime,steadyRssKb:rssKb,processPeakRssKb:peakKb,assets,warnings:(json.warnings||[]).map(x=>x.message),logging});
  console.log(JSON.stringify({arm,block,step,elapsedMs:elapsed,steadyRssKb:rssKb,peakKb,assets:Object.keys(assets).length}));
  if(step===6) { await finish(); return; }
  step++;
  const r=(step*37)%routes,l=(step*11)%leaves;
  editStart=performance.now(); editStartEpoch=Date.now()/1000;
  fs.writeFileSync(path.join(SOURCE,`route${r}`,`leaf${l}.js`),leaf(r,l,step));
 } catch(e) {await finish(e);}
});
setTimeout(()=>finish(new Error('Watch run timed out')),180000).unref();
