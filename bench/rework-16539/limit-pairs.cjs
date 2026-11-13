const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const checkFloor=require('./check-floor.cjs');
const [group,capArg,root]=process.argv.slice(2),cap=Number(capArg);
const W=process.env.GITHUB_WORKSPACE,R=path.join(W,'.c4b/results');fs.mkdirSync(R,{recursive:true});
const fixed={shared:['adv-c4.cjs','limitmc-starve,limitmc-late,limitsep-starve',27],combined:['adv-c3.cjs','limit,limitrec,limitretry,limitdrop,limitdrop2-ctx,limitdrop2-file',42],sequential:['adv-c3.cjs','limit,limitrec',15],retained:['adv-retained-folder.cjs','limitretain',8]};
const ids=(prefix,n)=>Array.from({length:n},(_,i)=>prefix+String(i+1).padStart(2,'0'));
const c5ids=s=>s.startsWith('async2-')?ids('Y',7):s.startsWith('async-')?ids('X',6):s==='share'?ids('S',8):s==='gen'?ids('G',8):s==='holder'?ids('H',6):s==='covhold'?ids('W',6):s==='closing'?ids('C',7):['B01-c0','B01-c1','B01-c2',...ids('B',6).slice(1),'B07-c0','B07-c1','B07-c2'];
const sessions=['async-single','async-multi','async-sep','async2-single','async2-multi','async2-sep','share','gen'];
const runs=fixed[group]?[{driver:fixed[group][0],sessions:fixed[group][1],wanted:fixed[group][2],env:{}}]:
 group==='async'?sessions.flatMap(s=>Array.from({length:cap===30&&root==='real'&&s.startsWith('async2-')?2:1},(_,rep)=>({driver:'adv-c5.cjs',sessions:s,keys:c5ids(s).map(id=>s+':'+id),env:{},rep}))):
 group==='busy'?['busy-r1','busy-r2','busy-r3'].map(s=>({driver:'adv-c5.cjs',sessions:s,keys:c5ids(s).map(id=>s+':'+id),env:{LIMIT_DIRS:'2500',BIG_DIRS:'800'}})):
 group==='holders'?['holder','covhold'].flatMap(s=>[1,2,3].map(rep=>({driver:'adv-c5.cjs',sessions:s,keys:c5ids(s).map(id=>s+':'+id),env:{},rep}))):
 group==='closing'?[0,25,50,75,100,150,200,300,0,50,100,200].map((delay,rep)=>({driver:'adv-c5.cjs',sessions:'closing',keys:c5ids('closing').map(id=>'closing:'+id),env:{CLOSE_DELAY:String(delay)},rep})):null;
assert(runs&&['real','link'].includes(root));
let bad=false;
for(let i=0;i<runs.length;i++){
 const run=runs[i],pair={};
 for(const arm of ['main','fix']){
  const hash=process.env[arm==='fix'?'CANDIDATE_BINDING_SHA256':'MAIN_BINDING_SHA256'];
  for(let attempt=1;attempt<=2;attempt++){
   const tag=`${group}-${cap}-${i}-attempt${attempt}`;
   const env={...process.env,...run.env,NSLIMIT:String(cap),PREFIX:cap?path.join(W,'bench/c4b/nslimit.sh'):''};
   if(cap===300&&group!=='retained')env.LIMIT_DIRS='400';
   const command=spawnSync('bash',['bench/c4b/arm.sh',arm,run.driver,tag,root,run.sessions],{env,stdio:'inherit'});
   const prefix=path.join(R,`${tag}-${root}-${arm}`);
   try{
    assert.equal(command.status,0,'Wrapper failed');
    const last=fs.readFileSync(path.join(R,'commands.tsv'),'utf8').trim().split('\n').at(-1).split('\t');
    assert.equal(last[1],`${tag}-${root}-${arm}`);assert.equal(last[2],'0','Actual driver failed');assert.equal(last[3],hash);
    const rows=fs.readFileSync(prefix+'.jsonl','utf8').trim().split('\n').map(JSON.parse);
    const identity=rows.filter(r=>r.type==='identity'),summary=rows.filter(r=>r.type==='summary'),steps=rows.filter(r=>r.type==='row'&&r.id!=='INIT');
    assert.equal(identity.length,1);assert.equal(identity[0].sha,hash);assert.equal(identity[0].mode,'native');assert.equal(fs.realpathSync(identity[0].binding),fs.realpathSync(last[4]));
    if(cap)assert(fs.readFileSync(prefix+'.stderr','utf8').includes(`nslimit=${cap}`));
    assert(!rows.some(r=>['failure','unsettled','recovery-timeout'].includes(r.type)));
    assert(!rows.some(r=>r.id==='INIT'&&r.errors?.length));
    assert.equal(summary.length,1);assert.equal(summary[0].rows,steps.length);assert.equal(summary[0].passed,steps.filter(r=>r.ok).length);
    const keys=steps.map(r=>r.scenario+':'+r.id);
    assert.equal(new Set(keys).size,keys.length);
    if(run.keys)assert.deepEqual([...keys].sort(),[...run.keys].sort());else assert.equal(steps.length,run.wanted);
    pair[arm]={prefix,rows,steps,hash,keys,attempt};break;
   }catch(error){fs.appendFileSync(path.join(R,'short.jsonl'),JSON.stringify({group,cap,root,i,arm,attempt,error:String(error)})+'\n');if(attempt===2){bad=true;console.error('SHORT',arm,run.sessions);}}
  }
 }
 if(!pair.main||!pair.fix)continue;
 try{
  assert.deepEqual([...pair.fix.keys].sort(),[...pair.main.keys].sort());
  if(run.keys){
   const result=spawnSync('jq',['-n','--slurpfile','cand',pair.fix.prefix+'.jsonl','--slurpfile','main',pair.main.prefix+'.jsonl','--arg','cHash',pair.fix.hash,'--arg','mHash',pair.main.hash,'--argjson','keys',JSON.stringify(run.keys),'-f','bench/rework-16539/main-floor.jq'],{encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);console.log(result.stdout);
  }else{
   checkFloor(pair.main.steps,pair.fix.steps);
  }
  const receipt={group,cap,root,session:run.sessions,index:i,rows:pair.main.steps.length,mainPassing:pair.main.steps.filter(r=>r.ok).length,lost:0,mainHash:pair.main.hash,candidateHash:pair.fix.hash};
  fs.appendFileSync(path.join(R,'floor.jsonl'),JSON.stringify(receipt)+'\n');console.log('MAIN_FLOOR',JSON.stringify(receipt));
 }catch(error){bad=true;fs.appendFileSync(path.join(R,'floor-failed.jsonl'),JSON.stringify({group,cap,root,session:run.sessions,index:i,error:String(error),main:pair.main.prefix,candidate:pair.fix.prefix})+'\n');console.error('FLOOR_FAILED',error);}
}
if(bad)process.exitCode=1;
