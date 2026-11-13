const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [repoArg,label,out]=process.argv.slice(2),repo=fs.realpathSync(repoArg);
const {sha}=require('./pin-native.cjs');
const {rspack}=require(path.join(repo,'packages/rspack/dist/index.js'));
const root=fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR,'focus-rss-')));
const fixture={'index.js':'const c = require.context("./ctx", true, /\\.js$/); module.exports = c.keys().sort().map(k => [k, c(k)]);','ctx/existing/seed.txt':'seed','plugin/nested/seed.txt':'before','plugin/kept/deep/file.txt':'kept'};
for(const [file,content] of Object.entries(fixture)){const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,content);const past=new Date(Date.now()-10000);fs.utimesSync(p,past,past);}
const compiler=rspack({context:root,mode:'development',devtool:false,target:'node',entry:'./index.js',output:{path:path.join(root,'dist'),filename:'bundle.js',library:{type:'commonjs2'}},experiments:{nativeWatcher:true},plugins:[c=>c.hooks.thisCompilation.tap('focus-rss',comp=>{comp.contextDependencies.add(path.join(root,'plugin'));comp.contextDependencies.add(path.join(root,'plugin/kept'));comp.fileDependencies.add(path.join(root,'plugin/kept/deep/file.txt'));})]});
let watching;
const first=new Promise((resolve,reject)=>{watching=compiler.watch({aggregateTimeout:50,followSymlinks:true},(error,stats)=>{if(error||stats.hasErrors())reject(error||new Error(stats.toString()));else resolve(stats);});});
(async()=>{try{const stats=await first;assert(stats.compilation.assets['bundle.js']);await new Promise(r=>setTimeout(r,300));if(global.gc)global.gc();const receipt={type:'focus-memory',label,sha,peakRssKiB:process.resourceUsage().maxRSS,steadyRssBytes:process.memoryUsage.rss()};fs.writeFileSync(out,JSON.stringify(receipt));console.log(JSON.stringify(receipt));}finally{await new Promise((r,j)=>watching.close(e=>e?j(e):r()));await new Promise((r,j)=>compiler.close(e=>e?j(e):r()));}})().catch(error=>{console.error(error);process.exitCode=1;});
