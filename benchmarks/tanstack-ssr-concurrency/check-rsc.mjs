import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
export const between=(text,start,end)=>{assert.equal(text.split(start).length,2,`unique start: ${start}`);const a=text.indexOf(start),b=text.indexOf(end,a+start.length);assert.ok(b>a,`end: ${end}`);return text.slice(a,b);};
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
export function structural(pristine,patched) {
 const rows=[];
 const check=(file,name,a,b)=>{rows.push({file,name,pristineSha256:sha(a),patchedSha256:sha(b),equal:a===b});};
 const pluginRegions=[['RSC branch','\t\t\tif (rscEnabled) {','\t\t\tconst logConcurrencyState'],['seedResolveModules','function seedResolveModules','function rebuildModulesContaining'],['rebuildModulesContaining','function rebuildModulesContaining','/**\n* Return the realpath']];
 for(const [name,start,end] of pluginRegions){const pristineEnd=name==='RSC branch'?'\t\t\tif (!rscEnabled) api.onAfterCreateCompiler':end;check('plugin.js',name,between(pristine['plugin.js'],start,pristineEnd),between(patched['plugin.js'],start,end));}
 for(const [name,start,end] of [['RSC production manifest call sites','\t\t\tif (api.context.action !== "dev" && rscEnabled) {','\t\t\tapi.onAfterEnvironmentCompile'],['shared RSC post-build call site','\t\t\tif (api.context.action === "build") api.onAfterBuild','\t\t}\n\t};']])check('plugin.js',name,between(pristine['plugin.js'],start,end),between(patched['plugin.js'],start,end));
 const changeStart='\t\t\t\tonServerFnsByIdChange: () => {';
 const changeEnd='\t\t\t});';
 const changeGuard='\t\t\t\t\tif (concurrentDev) resolverRevision = virtualModuleState.getResolverWriteRevision(serverFnProviderEnv);\n';
 check('plugin.js','RSC transform notification (non-RSC guard excluded)',between(pristine['plugin.js'],changeStart,changeEnd),between(patched['plugin.js'],changeStart,changeEnd).replace(changeGuard,''));
 const envStart='\t\t\tapi.onAfterEnvironmentCompile';
 const envEnd='\t\t\tif (api.context.action === "build")';
 let env=between(patched['plugin.js'],envStart,envEnd);
 const nonRscFollowUp=between(env,'\t\t\t\t\tif (concurrentDev) {','\n\t\t\t\t}\n')+'\n';
 env=env.replace(nonRscFollowUp,'').replace('\t\t\t\tif (clientBuild) {\n\t\t\t\t\tvirtualModuleState.updateManifest(clientBuild);\n\t\t\t\t}\n','\t\t\t\tif (clientBuild) virtualModuleState.updateManifest(clientBuild);\n');
 check('plugin.js','RSC client publication call sites (non-RSC guard excluded)',between(pristine['plugin.js'],envStart,envEnd),env);
 let v=patched['virtual-modules.js'];
 v=v.replace('\tconst resolverWriteRevisionByEnvironment = {};\n','');
 v=v.replace('\t\tgetResolverWriteRevision(environmentName) {\n\t\t\treturn resolverWriteRevisionByEnvironment[environmentName] ?? 0;\n\t\t},\n','');
 // Only this explicitly non-RSC addition may differ in the shared registration.
 const wrapStart='\t\tif (!opts.rscEnabled) {\n\t\t\tconst writeModule = vmPlugin.writeModule.bind(vmPlugin);';
 if(v.includes(wrapStart)){const wrap=between(v,wrapStart,'\t\tvmPlugins[envName] = vmPlugin;');v=v.replace(wrap,'');}
 check('virtual-modules.js','all stock RSC virtual module code',pristine['virtual-modules.js'],v);
 return {passed:rows.every(r=>r.equal),regions:rows};
}
export async function execution(pristine,patched,pkg,resultDir){
 // The watch fixture has no RSC client entry. Execute real exported virtual-state
 // implementations and the exact resolver hook body with minimal compiler plumbing.
 const outputs=[];
 for(const [label,dist] of [['pristine',pristine],['patched',patched]]){
  const modulePath=path.join(pkg,'dist/esm/rsbuild',`r2b-${label}-virtual-modules.mjs`);
  fs.writeFileSync(modulePath,dist['virtual-modules.js']);
  const {registerVirtualModules}=await import(modulePath);
  const callbacks=[];
  const api={context:{action:'dev'},modifyRspackConfig:fn=>callbacks.push(fn)};
  const opts={root:path.join(resultDir,'rsc-app'),rscEnabled:true,providerEnvName:'ssr',ssrIsProvider:true,serverFnsById:{},scriptFormat:'module',getDevClientEntryUrl:()=>'/js/index.js',getConfig:()=>({resolvedStartConfig:{basePaths:{publicBase:'/'}},startConfig:{server:{build:{inlineCss:{enabled:false}}}}})};
  const state=registerVirtualModules(api,opts);
  const writes=[];
  class VirtualModulesPlugin {constructor(initial){this.initial=initial;}writeModule(file,content){writes.push({file:path.basename(file),content});}}
  class NormalModuleReplacementPlugin {constructor(){}}
  const config={plugins:[],resolve:{}};
  callbacks.forEach(fn=>fn(config,{environment:{name:'ssr'},rspack:{experiments:{VirtualModulesPlugin},NormalModuleReplacementPlugin}}));
  const ready=[];config.plugins.filter(p=>p.apply).forEach(p=>p.apply({hooks:{thisCompilation:{tap:(_n,fn)=>ready.push(fn)}}}));ready.forEach(fn=>fn());
  state.tryUpdateServerFnResolver('export const literal = 1;');
  state.tryUpdateServerFnResolver('export const literal = 1;');
  assert.equal(writes.length,2,'RSC direct updater must write identical content twice');
  const hookSource=between(dist['plugin.js'],'\t\t\t\t\t\t\t}, async (compilation) => {\n\t\t\t\t\t\t\t\tconst resolver', '\t\t\t\t\t\t\t});');
  const helper=between(dist['plugin.js'],'function rebuildModulesContaining','/**\n* Return the realpath');
  const ctx=vm.createContext({virtualModuleState:state,serverFnProviderEnv:'ssr'});
  const hook=vm.runInContext(`${helper}\n(async (compilation) => {${hookSource.slice(hookSource.indexOf('{')+1)}})`,ctx);
  let rebuilt=0;
  const compilation={modules:[{identifier:()=>state.serverFnResolverPath}],rebuildModule(_m,cb){rebuilt++;cb();}};
  await hook(compilation);await hook(compilation);
  assert.equal(rebuilt,2);assert.equal(writes.length,4);
  outputs.push({label,writes,rebuilt});
  fs.unlinkSync(modulePath);
 }
 assert.deepEqual(outputs[1].writes,outputs[0].writes,'pristine/patched RSC emitted resolver bytes and write effects');
 return {passed:true,outputs};
}
if(process.argv[2]==='--structural'){
 const [,, ,pristineDir,patchedDir,out]=process.argv;
 const load=dir=>Object.fromEntries(['plugin.js','virtual-modules.js'].map(f=>[f,fs.readFileSync(path.join(dir,f),'utf8')]));
 const result=structural(load(pristineDir),load(patchedDir));fs.writeFileSync(out,JSON.stringify(result,null,2));assert.ok(result.passed,'RSC regions must be byte-identical before runner validation');
}
