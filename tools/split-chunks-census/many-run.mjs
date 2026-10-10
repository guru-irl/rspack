import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.env.SC_FIXTURE_ROOT);
const arm=process.env.SC_ARM;
const packageRoot=path.resolve(process.env.SC_RSPACK);
const {rspack}=await import(pathToFileURL(path.join(packageRoot,'dist/index.js')).href);
const every=arm==='every-priority-winner';
const groups={default:false,defaultVendors:false};
// 24 competing groups per winning stage produces >=10k candidates if all
// 500 distinct original sets survive. Mixed function/native selectors coexist.
for(let p=0;p<10;p++) {
  const winning=every || p%2===0;
  const tier=every?p:Math.floor(p/2);
  const expr=new RegExp(`[\\/]tier${tier}[\\/]leaf`);
  for(let g=0;g<(winning?24:1);g++) {
    groups[`stage${p}-group${g}`]={priority:100-p,minChunks:2,minSize:winning?0:1e12,chunks:'all',reuseExistingChunk:true,
      test:g<4 && winning ? m=>expr.test(m.resource||'') : expr};
  }
  if(winning) {
    // A single distinct slot is reserved for an actually winning named group.
    // Higher group index makes its equal-size anonymous competitor lose.
    groups[`stage${p}-named`]={priority:100-p,minChunks:2,minSize:0,chunks:'all',name:`named-${p}`,reuseExistingChunk:true,
      test:new RegExp(`[\\/]tier${tier}[\\/]named${String(tier).padStart(5,'0')}\\.js$`)};
  }
}
const output=path.join(root,'dist');
const compiler=rspack({context:path.join(root,'src'),mode:'development',cache:false,devtool:false,entry:'./entry.js',
 output:{path:output,filename:'[name].js',chunkFilename:'[name].js',clean:true},
 optimization:{minimize:false,concatenateModules:false,inlineExports:false,usedExports:false,
  splitChunks:{chunks:'all',minSize:0,minChunks:2,dedupDepth:0,usedExports:false,maxAsyncRequests:Infinity,maxInitialRequests:Infinity,cacheGroups:groups}},plugins:[]});
const leaf=path.join(root,'src/tier0/leaf00500.js');
const original=fs.readFileSync(leaf);
const records=[];
const compile=()=>new Promise((resolve,reject)=>compiler.run((error,stats)=>error?reject(error):resolve(stats)));
try {
 for(const phase of ['cold','edit','revert']) {
  if(phase!=='cold') fs.writeFileSync(leaf,phase==='edit'?'export const value=999999;\n':original);
  compiler.modifiedFiles=new Set(phase==='cold'?[]:[leaf]);
  const wall=performance.now(),cpu=process.cpuUsage();
  const stats=await compile();
  const cost=process.cpuUsage(cpu);
  if(stats.hasErrors()) throw Error(stats.toString({all:false,errors:true}));
  const c=stats.compilation;
  const routeCount=[...c.chunks].filter(c=>/^route-\d+$/.test(c.name||'')).length;
  const hashes={};
  for(const asset of c.getAssets()) hashes[asset.name]=crypto.createHash('sha256').update(asset.source.buffer()).digest('hex');
  records.push({phase,wallMs:performance.now()-wall,cpuUserMs:cost.user/1000,cpuSystemMs:cost.system/1000,modules:c.modules.size,chunks:c.chunks.size,routeCount,hashes,usage:process.resourceUsage()});
  console.log(arm,phase,'routes',routeCount,'modules',c.modules.size,'chunks',c.chunks.size);
 }
} finally {
 fs.writeFileSync(leaf,original);
 await new Promise((resolve,reject)=>compiler.close(e=>e?reject(e):resolve()));
 fs.writeFileSync(process.env.SC_RESULT,JSON.stringify({arm,records}));
}
