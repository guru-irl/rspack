import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/rsbuild';
const out=process.env.RESULT_DIR;
const probe={name:'production-parity',setup(api){
 api.modifyRspackConfig(config=>{config.devtool=false;});
 api.onAfterCreateCompiler(({compiler})=>{
  const map=Object.fromEntries(compiler.compilers.map(c=>[c.name,{map:compiler.dependencies.get(c)||[],options:c.options.dependencies||[]}]));
  fs.writeFileSync(path.join(out,'production-dependencies.json'),JSON.stringify(map,null,2));
  const taps=Object.fromEntries(compiler.compilers.map(c=>[c.name,Object.fromEntries(Object.entries(c.hooks).filter(([_,hook])=>hook.taps?.some(t=>t.name.startsWith('TanStackStart'))).map(([key,hook])=>[key,hook.taps.filter(t=>t.name.startsWith('TanStackStart')).map(t=>({name:t.name,stage:t.stage||0,type:t.type}))]))]));
  fs.writeFileSync(path.join(out,'production-taps.json'),JSON.stringify(taps,null,2));
 });
}};
const rsbuild=await createRsbuild({config:{plugins:[pluginReact(),tanstackStart(),probe],
 environments:process.env.COMPILER_COUNT==='4'?Object.fromEntries(['aux-a','aux-b'].map(name=>[name,{source:{entry:{index:`./aux/${name}.js`}},output:{target:'web',distPath:{root:`dist/${name}`}},tools:{htmlPlugin:false}}])):undefined,
 performance:{buildCache:false}}});
await rsbuild.build();
const assets={};
const walk=directory=>{for(const item of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())walk(file);else assets[path.relative('dist',file)]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}};
walk('dist');fs.writeFileSync(path.join(out,'production-assets.json'),JSON.stringify(assets,null,2));
fs.writeFileSync(path.join(out,'success.json'),JSON.stringify({passed:true}));
