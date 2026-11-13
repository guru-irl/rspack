const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const checkFloor=require('./check-floor.cjs');
const out=path.resolve(process.argv[2]);fs.mkdirSync(out,{recursive:true});
const hash='a'.repeat(64),row={type:'row',scenario:'control',id:'X03',kind:'rebuild',who:'c0',ok:true,noticed:true,perCompiler:{c0:1},newErrors:[]};
const base=[{type:'identity',mode:'native',sha:hash},row,{type:'summary',rows:1,passed:1}];
const m=path.join(out,'main.jsonl'),c=path.join(out,'candidate.jsonl');
const write=(file,xs)=>fs.writeFileSync(file,xs.map(x=>JSON.stringify(x)).join('\n')+'\n');write(m,base);
function run(xs){write(c,xs);return spawnSync('jq',['-n','--slurpfile','main',m,'--slurpfile','cand',c,'--arg','mHash',hash,'--arg','cHash',hash,'--argjson','keys','["control:X03"]','-f',path.join(__dirname,'main-floor.jq')],{encoding:'utf8'}).status;}
assert.equal(run(base),0,'Valid receipt rejected');
const mutations={identity:xs=>{xs[0].sha='b'.repeat(64);},missing:xs=>{xs.splice(1,1);xs.at(-1).rows=0;xs.at(-1).passed=0;},duplicate:xs=>{xs.splice(1,0,structuredClone(xs[1]));xs.at(-1).rows=2;xs.at(-1).passed=2;},delivery:xs=>{xs[1].noticed=false;},compiler:xs=>{xs[1].perCompiler={c1:1};},kind:xs=>{xs[1].kind='quiet';}};
for(const [name,mutate] of Object.entries(mutations)){const xs=structuredClone(base);mutate(xs);assert.notEqual(run(xs),0,name+' was accepted');console.log(JSON.stringify({type:'negative-control',name,rejected:true}));}
const output={scenario:'output',id:'A',kind:'rebuild',ok:true,noticed:true,outputOk:true,expected:[['a',1],['b',2]],actual:[['a',1],['b',2]],newErrors:[]};
checkFloor([output],[structuredClone(output)]);
const wrong=structuredClone(output);wrong.actual=[['a',2],['b',1]];
assert.throws(()=>checkFloor([output],[wrong]));console.log(JSON.stringify({type:'negative-control',name:'output-assignment',rejected:true}));
assert.throws(()=>checkFloor([output],[]));console.log(JSON.stringify({type:'negative-control',name:'core-missing-row',rejected:true}));
