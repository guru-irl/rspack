const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]);fs.mkdirSync(root,{recursive:true});
const files=[],missing=[],contexts=[],noise=[];const past=new Date(Date.now()-60000);
for(let i=0;i<1000;i++)fs.mkdirSync(path.join(root,'source',`dir-${i}`),{recursive:true});
for(let i=0;i<50000;i++){const p=path.join(root,'source',`dir-${i%1000}`,`dep-${i}.txt`);fs.writeFileSync(p,'dependency\n');fs.utimesSync(p,past,past);files.push(p);}
for(let i=0;i<176000;i++){const dir=path.join(root,'source',`dir-${i%1000}`),base=`miss-${Math.floor(i/3)}`;missing.push(i%3===2?path.join(dir,base,'index.ts'):path.join(dir,base+(i%3===0?'.ts':'.tsx')));}
for(let i=0;i<10;i++){const p=path.join(root,'contexts',`ctx-${i}`);fs.mkdirSync(p,{recursive:true});contexts.push(p);}
for(let i=0;i<200;i++){const p=path.join(root,'contexts','ctx-0',`node_modules-noise-${i}.txt`);fs.writeFileSync(p,'old');noise.push(p);}
for(const role of ['client','busy']){const dir=path.join(root,role);fs.mkdirSync(dir,{recursive:true});for(const [name,text]of [['owner.js','module.exports = 0;\n'],['index.js',"require('./owner.js'); module.exports = 1;\n"]]){const p=path.join(dir,name);fs.writeFileSync(p,text);fs.utimesSync(p,past,past);}}
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({files,missing,contexts,noise}));console.log(JSON.stringify({files:files.length,missing:missing.length,contexts:contexts.length,noise:noise.length}));
