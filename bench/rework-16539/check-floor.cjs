const assert=require('node:assert/strict');
const {isDeepStrictEqual}=require('node:util');
const key=r=>JSON.stringify([r.scenario,r.followSymlinks,r.id]);
module.exports=(main,candidate)=>{
 assert.equal(new Set(main.map(key)).size,main.length,'Duplicate main row');
 assert.equal(new Set(candidate.map(key)).size,candidate.length,'Duplicate candidate row');
 assert.deepEqual(candidate.map(key).sort(),main.map(key).sort(),'Missing or extra row');
 for(const m of main){const c=candidate.find(r=>key(r)===key(m));assert.equal(c.kind,m.kind);assert.equal(c.who,m.who);
  if(m.ok){assert(c.ok,key(m));assert.notEqual(c.outputOk,false);if(c.expected!==undefined)assert(isDeepStrictEqual(c.actual,c.expected),'Wrong output '+key(m));if(m.noticed)assert(c.noticed,'Lost delivery '+key(m));assert(!c.newErrors?.length,'New error '+key(m));}
 }
 return{rows:main.length,mainPassing:main.filter(r=>r.ok).length,lost:0};
};
