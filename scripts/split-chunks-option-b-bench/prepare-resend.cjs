const fs=require('node:fs'),path=require('node:path');
fs.mkdirSync(process.argv[2],{recursive:true});const root=fs.realpathSync(process.argv[2]),files=[],contexts=[],past=new Date(Date.now()-60000);
for(let i=0;i<3000;i++){const dir=path.join(root,'contexts',String(i));fs.mkdirSync(dir,{recursive:true});contexts.push(dir);}
for(let i=0;i<80000;i++){const file=path.join(contexts[i%3000],`file-${i}.txt`);fs.writeFileSync(file,'original');fs.utimesSync(file,past,past);files.push(file);}
for(let i=0;i<8;i++){const file=path.join(root,`ready-${i}.txt`);fs.writeFileSync(file,'ready');fs.utimesSync(file,past,past);}
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({files,contexts}));console.log(JSON.stringify({files:files.length,contexts:contexts.length}));
