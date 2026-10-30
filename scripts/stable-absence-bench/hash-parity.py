from pathlib import Path
import hashlib,json,os,subprocess,sys
root=Path(sys.argv[1]).resolve();repo=Path(sys.argv[2]).resolve();system=sys.argv[3]
out=root/'hash-results';data={};identity={}
for label,commit in [('base','cc2f2fa5cf1b910b7e0aaf379aba834e935c32c8'),('pr','4e2ab244c21ec39d3e5748df18c8a5ca20bd488e')]:
 art=root/'bindings'/f'absence-binding-{system}-{label}'
 assert (art/'commit.sha').read_text().strip()==commit
 identity[label]=hashlib.sha256((art/'binding.node').read_bytes()).hexdigest()
 core=art/'core'
 for name,target in [('node_modules',repo/'packages/rspack/node_modules'),('compiled',repo/'packages/rspack/compiled')]:
  if not (core/name).exists():
   if sys.platform=='win32':subprocess.run(['cmd','/c','mklink','/J',str(core/name),str(target)],check=True,stdout=subprocess.DEVNULL)
   else:(core/name).symlink_to(target,target_is_directory=True)
 env=dict(os.environ,RSPACK_BINDING=str(art/'binding.node'),NAPI_RS_NATIVE_LIBRARY_PATH=str(art/'binding.node'),EXPECTED_BINDING_SHA256=identity[label],NODE_OPTIONS='--max-old-space-size=8192',RSPACK_SPLIT_CHUNKS_REPLAY='off',TMPDIR=str(root/'tmp'))
 for key in ('MEASURE_MEMORY','RSPACK_CODE_SPLITTING_CACHE_STABLE_ABSENCE','RSPACK_CODE_SPLITTING_CACHE_DEBUG'):env.pop(key,None)
 cmd=['node','--expose-gc',str(repo/'scripts/stable-absence-bench/run.mjs'),str(root/'hash-fixture'),str(core),str(out/(label+'.json')),'barrel']
 with (out/(label+'.log')).open('w') as log:
  subprocess.run(cmd,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=1200)
 j=json.loads((out/(label+'.json')).read_text());assert not j.get('error') and len(j['records'])==3 and j['extraBuilds']==0
 assert j['bindingSha256']==identity[label]
 assert all(r['topologyChanged']==(label=='base') for r in j['records'][1:])
 data[label]=j
rows=[]
for a,b in zip(data['base']['records'],data['pr']['records']):
 assert a['phase']==b['phase']
 for field in ('assets','membership','modules','chunks'):assert a[field]==b[field],('PARITY_STOP',a['phase'],field)
 rows.append({'phase':a['phase'],'absenceOffHash':a['statsHash'],'absenceOnHash':b['statsHash'],'hashesEqual':a['statsHash']==b['statsHash'],'bytesEqual':True,'membershipEqual':True,'offHasHashLiteral':a['hasCompilationHashLiteral'],'onHasHashLiteral':b['hasCompilationHashLiteral']})
summary={'platform':system,'replay':'off in both arms','identities':identity,'rows':rows,'candidateForFoldFix':any(not r['hashesEqual'] for r in rows)}
(out/'hash-comparison.json').write_text(json.dumps(summary,indent=2)+'\n')
# Preserve the complete config and steps even when this fixture does not reproduce the gap.
source=(repo/'scripts/stable-absence-bench/run.mjs').read_text()
(out/'case-run.mjs').write_text(source)
for name in ('prepare.mjs','add-barrel.mjs'):(out/name).write_bytes((repo/'scripts/stable-absence-bench'/name).read_bytes())
(out/'case.json').write_text(json.dumps({'generatorSource':'a4ca7fd6ff8bc31a48de4ef91922fcb1af1e53dc','mode':'development','sideEffects':'flag','usedExports':False,'incremental':True,'target':'node','entry':'./entry.js','replay':'off','steps':['cold','barrel/constants.js becomes export const value = "edited";','barrel/constants.js restored to export const value = "cold";'],'absenceOffSource':'cc2f2fa5cf1b910b7e0aaf379aba834e935c32c8','absenceOnSource':'4e2ab244c21ec39d3e5748df18c8a5ca20bd488e'},indent=2)+'\n')
print(json.dumps(summary,indent=2))
