import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
export function staticCloseSites(app, fixture, work) {
 const require=createRequire(path.join(app,'package.json'));
 const {parse}=require('acorn');
 const sites=[], failures=[], packages=new Set();
 let scanned=0;
 const owner=file=>{let d=path.dirname(file);while(d!==path.dirname(d)){const f=path.join(d,'package.json');if(fs.existsSync(f)){try{const p=JSON.parse(fs.readFileSync(f));return `${p.name||'fixture'}@${p.version||'local'}`;}catch{}}d=path.dirname(d);}return 'fixture@local';};
 const scan=(file,text,variant='installed')=>{
  scanned++;
  if(!/['"]close['"]/.test(text))return;
  let tree;
  try{tree=parse(text,{ecmaVersion:'latest',sourceType:'module',allowReturnOutsideFunction:true,allowAwaitOutsideFunction:true,locations:true});}
  catch(error){try{tree=parse(text,{ecmaVersion:'latest',sourceType:'script',allowReturnOutsideFunction:true,locations:true});}catch{failures.push({file:path.relative(app,file),error:error.message});return;}}
  const visit=node=>{
   if(!node||typeof node!=='object')return;
   if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'){
    const method=node.callee.computed?node.callee.property.value:node.callee.property.name;
    const [event,callback]=node.arguments;
    if(['on','once','addListener','prependListener','prependOnceListener'].includes(method)&&event?.value==='close'){
     const cb=callback?text.slice(callback.start,callback.end):'';
     const lines=text.split('\n');
     sites.push({package:owner(file),variant,file:path.relative(app,file),line:node.loc.start.line,method,receiver:text.slice(node.callee.object.start,node.callee.object.end),callback:cb,closeReference:/\.close\b|\bclose\s*\(/.test(cb),excerpt:lines.slice(Math.max(0,node.loc.start.line-4),node.loc.end.line+3).join('\n').slice(0,5000)});
    }
   }
   for(const [key,v]of Object.entries(node)){if(['loc','start','end'].includes(key))continue;if(Array.isArray(v))for(const c of v)visit(c);else if(v&&typeof v==='object')visit(v);}
  };
  visit(tree);
 };
 const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile()&&/\.(?:js|mjs|cjs)$/.test(e.name))scan(f,fs.readFileSync(f,'utf8'));else if(e.isFile()&&e.name==='package.json'){try{const p=JSON.parse(fs.readFileSync(f));packages.add(`${p.name}@${p.version}`);}catch{}}}};
 walk(path.join(app,'node_modules'));
 for(const file of fs.readdirSync(fixture))if(/\.(?:js|mjs|cjs)$/.test(file))scan(path.join(fixture,file),fs.readFileSync(path.join(fixture,file),'utf8'),'harness');
 const patched=path.join(work,'static-patched');
 fs.mkdirSync(path.join(patched,'dist/esm/rsbuild'),{recursive:true});
 for(const name of ['plugin.js','virtual-modules.js'])fs.copyFileSync(path.join(app,'node_modules/@tanstack/start-plugin-core/dist/esm/rsbuild',name),path.join(patched,'dist/esm/rsbuild',name));
 const applied=spawnSync('patch',['--batch','--fuzz=0','-p1','-i',path.join(fixture,'start-plugin-core-1.171.46-combined.patch')],{cwd:patched,encoding:'utf8'});
 assert.equal(applied.status,0,applied.stdout+applied.stderr);assert.ok(!/offset|fuzz|FAILED/i.test(applied.stdout+applied.stderr));
 for(const name of ['plugin.js','virtual-modules.js'])scan(path.join(app,'node_modules/@tanstack/start-plugin-core/dist/esm/rsbuild',name),fs.readFileSync(path.join(patched,'dist/esm/rsbuild',name),'utf8'),'patched');
 const implementations=[];
 const capture=(file,text,terms)=>{for(const term of terms){let i=-1;while((i=text.indexOf(term,i+1))>=0)implementations.push({file,term,line:text.slice(0,i).split('\n').length,excerpt:text.slice(Math.max(0,i-500),i+1700)});}};
 capture(`node@${process.versions.node}/lib/net.js`,process.binding('natives').net,['Server.prototype.close =','function close()']);
 capture(`node@${process.versions.node}/lib/events.js`,process.binding('natives').events,['function onceWrapper']);
 for(const name of fs.readdirSync(path.join(app,'node_modules/@rsbuild/core/dist')))if(/\.js$/.test(name)) {
  const file=path.join(app,'node_modules/@rsbuild/core/dist',name);
  capture(path.relative(app,file),fs.readFileSync(file,'utf8'),['server.close(','httpServer.close(','closeServer =','closeServer()','async function closeServer','createDevServer =']);
 }
 fs.writeFileSync(path.join(work,'static-close-implementation.json'),JSON.stringify(implementations,null,2));
 const result={scanned,packages:[...packages].sort(),failures,sites};
 fs.writeFileSync(path.join(work,'static-close-sites.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({scanned,failures,sites:sites.map(({excerpt,...s})=>s)},null,2));
 assert.equal(failures.length,0,'all close-bearing sources parsed');
}
