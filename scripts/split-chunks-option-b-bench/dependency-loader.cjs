const fs=require('node:fs');
module.exports=function(source){
 this.cacheable(true);
 const {manifest,role}=this.getOptions(),m=JSON.parse(fs.readFileSync(manifest,'utf8'));
 for(const f of role==='client'?m.files:m.files.slice(0,25000))this.addDependency(f);
 for(const f of role==='client'?m.missing:m.missing.slice(0,80000))this.addMissingDependency(f);
 if(role==='client')for(const f of m.contexts)this.addContextDependency(f);
 return source;
};
