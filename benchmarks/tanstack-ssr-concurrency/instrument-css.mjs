// Diagnostic-only runtime copy. The ordinary correctness runner and assertions
// remain untouched. One known cross-process URL assertion is observed, not gated.
import assert from 'node:assert/strict';
export const instrumentCSS=(source)=>{
 const replace=(old,next)=>{assert.ok(source.includes(old),`diagnostic insertion: ${old.slice(0,80)}`);source=source.replace(old,next);};
 replace("const checks = [];",`const checks = [];
const cssCheckpoints=[];
let cssPass=0;
const routeCSS=entry=>{
 const values=new Set();
 const collect=v=>{if(typeof v==='string' && /\\.css(?:[?#]|$)/.test(v))values.add(v);else if(Array.isArray(v))v.forEach(collect);else if(v && typeof v==='object')Object.values(v).forEach(collect);};
 collect(entry);return [...values].sort();
};
const captureCSS=(responses)=>{
 const manifest=JSON.parse(JSON.stringify(globalThis.__TSS_DEV_START_MANIFEST__));
 const client=builds.filter(b=>b.name==='client').at(-1);
 cssCheckpoints.push({index:cssCheckpoints.length,step,manifest,responses,cssAssets:client.cssAssets,chunks:client.cssChunks,fullHash:client.hash,
 routeCSS:Object.fromEntries(Object.entries(responses).map(([route])=>[route,routeCSS([manifest.routes.__root__,manifest.routes[route]])]))});
 fs.writeFileSync(path.join(out,'css-checkpoints.json'),JSON.stringify(cssCheckpoints,null,2));
};`);
 replace("compilers.set(environment.name,compiler);",`compilers.set(environment.name,compiler);
 const optionValue=v=>typeof v==='function'?v.toString():v;
 fs.writeFileSync(path.join(out,environment.name+'-resolved-output.json'),JSON.stringify(Object.fromEntries(['cssFilename','cssChunkFilename','filename','chunkFilename','hashFunction','hashDigest','hashDigestLength','hashSalt'].map(k=>[k,optionValue(compiler.options.output[k])])),null,2));`);
 replace("current.set(environment.name, record);",`record.cssPass=++cssPass;
        current.set(environment.name, record);`);
 replace("record.assets = compilation.getAssets()",`if(environment.name==='client') {
 const prefix=path.join('css',String(record.cssPass));
 record.cssAssets=compilation.getAssets().filter(a=>a.name.endsWith('.css')).map(a=>{
  const value=a.source.buffer();const file=path.join(prefix,a.name);fs.mkdirSync(path.dirname(path.join(out,file)),{recursive:true});fs.writeFileSync(path.join(out,file),value);
  return {name:a.name,sha256:hash(value),bytes:value.length,file};
 }).sort((a,b)=>a.name.localeCompare(b.name));
 record.cssChunks=[...compilation.chunks].map(c=>({id:c.id,name:c.name,hash:c.hash,contentHash:c.contentHash,files:[...c.files].sort(),modules:[...compilation.chunkGraph.getChunkModulesIterable(c)].map(m=>({identifier:normalize(m.identifier()),id:compilation.chunkGraph.getModuleId(m)}))}));
}
           record.assets = compilation.getAssets()`);
 replace("checks.push(check); console.log", "captureCSS(responses);\n   checks.push(check); console.log");
 replace("assert.ok(expectedCSS.every(url=>windowEvidence.css.includes(url)),'window HTML references NEW CSS asset required by stock route manifest');",`windowEvidence.crossArmLiteralMatch=expectedCSS.every(url=>windowEvidence.css.includes(url));
  windowEvidence.diagnosticOnly=true;
  fs.writeFileSync(path.join(out,'request-window.json'),JSON.stringify(windowEvidence,null,2));
  captureCSS({'/':{css:windowEvidence.css}});`);
 return source;
};
