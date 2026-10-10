const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]);fs.mkdirSync(root,{recursive:true});
const count=Number(process.env.FILENAME_CHUNKS||5000),entries=10;
if(count%entries)throw Error('chunk count must be divisible by ten');
for(let i=0;i<count;i++){
 const id=String(i).padStart(4,'0');
 fs.writeFileSync(path.join(root,`chunk-${id}.js`),`import './style-${id}.css';\nexport const url = new URL('./shared.svg', import.meta.url);\nexport default ${i};\n`);
 fs.writeFileSync(path.join(root,`style-${id}.css`),`.chunk-${id} { color: rgb(${i%256}, ${(i*7)%256}, ${(i*13)%256}); }\n`);
}
fs.writeFileSync(path.join(root,'shared.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>');
for(let e=0;e<entries;e++){
 const lines=[];for(let i=e*count/entries;i<(e+1)*count/entries;i++){
  const id=String(i).padStart(4,'0');lines.push(`() => import(/* webpackChunkName: 'Chunk-${id}' */ './chunk-${id}.js'),`);
 }
 fs.writeFileSync(path.join(root,`entry-${e}.js`),'export const load = [\n'+lines.join('\n')+'\n];\n');
}
console.log(JSON.stringify({chunks:count,entries,fixture:root}));
