import fs from 'node:fs';
import path from 'node:path';
const root = process.env.BENCH_ROOT;
if (!root) throw Error('BENCH_ROOT required');
for (const [label, n, shared, roots] of [['small',480,279,80],['large',3100,144,100]]) {
 const dir=path.join(root,`fixture-${label}`); fs.mkdirSync(dir,{recursive:true});
 const query=i => i%20===0?'?tsr-split=component':i%31===0?`?tss-hydrate=island${i}`:'';
 const imp=i => `import(/* webpackChunkName: "async-${i}" */ './async-${i}.js${query(i)}')`;
 fs.writeFileSync(path.join(dir,'index.js'), `export const start=()=>Promise.all([${Array.from({length:roots},(_,i)=>imp(i)).join(',')}]); globalThis.h1=start;`);
 for(let j=0;j<shared;j++) for(let k=0;k<4;k++) {
  fs.writeFileSync(path.join(dir,`shared-${j}-${k}.js`),`export const value=${j*17+k};`);
 }
 for(let i=0;i<n;i++) {
  let body=''; let variables=[];
  for(const j of [i%shared,(i+37)%shared]) for(let k=0;k<4;k++) {
   const v=`v${j}_${k}`; body+=`import {value as ${v}} from './shared-${j}-${k}.js';\n`; variables.push(v);
  }
  for(let k=0;k<6;k++) {
   const filename=`leaf-${i}-${k}.js`; const v=`l${k}`; variables.push(v);
   fs.writeFileSync(path.join(dir,filename),`export const value=${i*7+k};`);
   body+=`import {value as ${v}} from './${filename}';\n`;
  }
  if(i%10===0) { const css=`style-${i}.css`; fs.writeFileSync(path.join(dir,css),`.route${i}{color:rgb(${i%256},42,63)}`); body+=`import './${css}';\n`; }
  const children=[];
  // Breadth-first forest, four children per non-leaf.
  for(let k=0;k<4;k++) { const child=roots+i*4+k; if(child<n) children.push(imp(child)); }
  body+=`export const value=${variables.join('+')}; export const load=()=>Promise.all([${children.join(',')}]);\n`;
  fs.writeFileSync(path.join(dir,`async-${i}.js`),body);
 }
 console.log(JSON.stringify({label,n,shared,roots,chunksExpected:n+shared+1}));
}
