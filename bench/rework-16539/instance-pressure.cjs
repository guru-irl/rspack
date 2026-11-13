const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [repoArg,label,capArg,out]=process.argv.slice(2),repo=fs.realpathSync(repoArg),cap=Number(capArg);
const {binding:{NativeWatcher},sha}=require('./pin-native.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const instances=()=>fs.readdirSync('/proc/self/fd').filter(fd=>{try{return fs.readlinkSync('/proc/self/fd/'+fd).includes('inotify');}catch{return false;}}).length;
const root=fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR,'instance-'))),watchers=[],errors=[],rows=[];
async function make(id){
 const dir=path.join(root,String(id)),ctx=path.join(dir,'ctx'),file=path.join(dir,'index.js');fs.mkdirSync(path.join(ctx,'nested'),{recursive:true});fs.writeFileSync(path.join(ctx,'nested/seed.txt'),'0');fs.writeFileSync(file,'0');
 const watcher=new NativeWatcher({aggregateTimeout:20,followSymlinks:true}),batches=[];watchers.push(watcher);
 watcher.watch([[file],[]],[[ctx],[]],[[],[]],BigInt(Date.now()),(error,batch)=>{if(error)errors.push(String(error));else batches.push(batch);},()=>{});
 const end=Date.now()+5000;while(!watcher.collectTimeInfoEntries().fileTimestamps.entries.some(e=>e.path.endsWith('seed.txt'))&&Date.now()<end)await wait(10);
 assert(watcher.collectTimeInfoEntries().fileTimestamps.entries.some(e=>e.path.endsWith('seed.txt')),'Scan incomplete');await wait(100);return{watcher,file,batches};
}
(async()=>{try{
 const peers=[];
 if(cap===8)for(let i=0;i<4;i++)peers.push(await make(i));
 const before=instances(),last=await make(9);
 for(const [id,live] of [['required-file',last],...(peers.length?[['idle-peer',peers[0]]]:[])]){
  live.batches.length=0;fs.writeFileSync(live.file,'1');
  const end=Date.now()+5000;while(!live.batches.some(b=>b.changedFiles.includes(live.file))&&Date.now()<end)await wait(10);
  rows.push({id,noticed:live.batches.some(b=>b.changedFiles.includes(live.file)),instancesBefore:before,instancesAfter:instances(),errors:[...errors]});
 }
}finally{for(const watcher of watchers)await watcher.close();}
const end=Date.now()+3000;while(instances()&&Date.now()<end)await wait(10);const receipt={type:'instance-pressure',label,sha,cap,rows,closed:instances()===0};fs.writeFileSync(out,JSON.stringify(receipt));console.log(JSON.stringify(receipt));assert(rows.every(r=>r.noticed&&r.errors.length===0)&&receipt.closed);
})().catch(error=>{console.error(error);process.exitCode=1;});
