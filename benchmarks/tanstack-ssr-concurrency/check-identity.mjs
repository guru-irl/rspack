import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export async function captureIdentity(pristine, pkg, work) {
 const file=path.join(pkg,'dist/esm/rsbuild/normalized-client-build.js');
 const patched=fs.readFileSync(file,'utf8');
 const capture=async(label,text)=>{
  const target=path.join(path.dirname(file),`identity-${label}.mjs`);fs.writeFileSync(target,text);
  try {
   const {registerClientBuildCapture}=await import(pathToFileURL(target));let callback;
   registerClientBuildCapture({context:{action:'dev'},processAssets(options,fn){assert.deepEqual(options,{stage:'report',environments:['client']});callback=fn;}},()=>({}));
   assert.equal(typeof callback,'function');return Function.prototype.toString.call(callback);
  } finally {fs.unlinkSync(target);}
 };
 const before=await capture('pristine',pristine),after=await capture('patched',patched);
 assert.equal(after.replace(/\s/g,''),before.replace(/\s/g,''),'client processAssets capture callback whitespace-stripped toString identity');
 assert.equal(patched,pristine,'normalized-client-build.js remains entirely pristine');
 const result={passed:true,sha256:crypto.createHash('sha256').update(before).digest('hex'),source:before};
 fs.writeFileSync(path.join(work,'r3-capture-identity.json'),JSON.stringify(result,null,2));return result;
}

export function functionInventory(pristine,patched,work) {
 const {parse}=createRequire(path.join(work,'app/package.json'))('acorn');
 const rows=[];
 for(const file of Object.keys(patched)) {
  const collect=text=>{
   const tree=parse(text,{ecmaVersion:'latest',sourceType:'module',locations:true});const functions=[];
   const visit=(node,route,label)=>{
    if(!node||typeof node!=='object')return;
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))functions.push({route,text:text.slice(node.start,node.end),line:node.loc.start.line,name:node.id?.name||label||route});
    for(const [key,value] of Object.entries(node)) {
     if(['loc','start','end'].includes(key))continue;
     if(Array.isArray(value))value.forEach((child,i)=>visit(child,`${route}.${key}[${i}]`,label));
     else if(value&&typeof value==='object')visit(value,`${route}.${key}`,node.type==='Property'?(node.key.name||node.key.value):node.type==='VariableDeclarator'?node.id.name:node.type==='CallExpression'?`${text.slice(node.callee.start,node.callee.end)} callback`:label);
    }
   };visit(tree,'module');return functions;
  };
  const before=collect(pristine[file]),after=collect(patched[file]);
  // Match unchanged source first, with multiplicity. Any remaining old function
  // is source-text changed or removed; new unmatched functions are also listed.
  const available=[...after];
  for(const fn of before) {
   const same=available.findIndex(other=>other.text===fn.text);
   if(same>=0)available.splice(same,1);
   else rows.push({file,status:'changed or removed',name:fn.name,pristineLine:fn.line,pristineSha256:crypto.createHash('sha256').update(fn.text).digest('hex')});
  }
  rows.push(...available.map(fn=>({file,status:'changed or added',name:fn.name,patchedLine:fn.line,patchedSha256:crypto.createHash('sha256').update(fn.text).digest('hex')})));
 }
 fs.writeFileSync(path.join(work,'r3-function-inventory.json'),JSON.stringify(rows,null,2));return rows;
}
