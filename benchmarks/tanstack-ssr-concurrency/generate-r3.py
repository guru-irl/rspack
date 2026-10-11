import difflib, hashlib, json, sys
from pathlib import Path
pristine, v2, output, patch = map(Path, sys.argv[1:])
output.mkdir(parents=True,exist_ok=True)
proof=[]; patches=[]
for file in ['plugin.js','virtual-modules.js']:
 stock=(pristine/file).read_text(); old=(v2/file).read_text(); new=old
 if file=='plugin.js':
  reason='!("compilers" in compiler) || compiler.compilers.length !== 2 ? "compiler-count" : "names-or-dependencies"'
  assert reason in new
  new=new.replace(reason, '!("compilers" in compiler) || !compiler.compilers.some((c) => c.name === RSBUILD_ENVIRONMENT_NAMES.client) || !compiler.compilers.some((c) => c.name === RSBUILD_ENVIRONMENT_NAMES.server) ? "names" : "user-dependency"')
  new=new.replace(' && compiler.compilers.length === 2','')
  new=new.replace(' && process.env.TSS_SSR_CONCURRENT !== "0" && ssrIsProvider', ' && ssrIsProvider')
  new=new.replace('if (!rscEnabled) api.onAfterCreateCompiler(({ compiler }) => {', 'if (!rscEnabled) api.onAfterCreateCompiler(({ compiler }) => {\n\t\t\t\tlet userDependency = false;')
  a=new.index('\t\t\t\t\tconst hasDependencies ='); b=new.index('\t\t\t\t\t\tconcurrentDev = true;',a)
  block='\t\t\t\t\t'+"""const reaches = (from, target) => {
						const visited = new Set();
						const pending = [from.name];
						while (pending.length) {
							const name = pending.pop();
							if (name === target.name) return true;
							if (visited.has(name)) continue;
							visited.add(name);
							const child = compiler.compilers.find((c) => c.name === name);
							if (child) pending.push(...(compiler.dependencies?.get(child) ?? []), ...(child.options.dependencies ?? []));
						}
						return false;
					};
					userDependency = Boolean(clientCompiler && serverCompiler && (reaches(clientCompiler, serverCompiler) || reaches(serverCompiler, clientCompiler)));
					if (process.env.TSS_SSR_CONCURRENT !== "0" && clientCompiler && serverCompiler && !userDependency) {
"""
  new=new[:a]+block+new[b:]
  tail='\t\t\t\t\t\tlogConcurrencyState(compiler);\n\t\t\t\t\t\treturn;\n'
  assert tail in new;new=new.replace(tail,'')
  loop='for (const environmentName of startCompilerServerEnvironmentNames) {\n\t\t\t\t\tconst serverCompiler'
  assert loop in new;new=new.replace(loop, 'for (const environmentName of startCompilerServerEnvironmentNames) {\n\t\t\t\t\tif (concurrentDev && environmentName === RSBUILD_ENVIRONMENT_NAMES.server) continue;\n\t\t\t\t\tconst serverCompiler')
  new=new.replace('\t\t\tif (rscEnabled) api.onAfterCreateCompiler', '\t\t\tlet clientRequestWindow;\n\t\t\tlet releaseClientRequests;\n\t\t\tlet clientRequestRevision = 0;\n\t\t\tlet compilingClientRequestRevision = 0;\n\t\t\tconst requestGateEnvironments = new WeakSet();\n\t\t\tconst beginClientRequestWindow = () => {\n\t\t\t\tclientRequestRevision++;\n\t\t\t\tif (!clientRequestWindow) clientRequestWindow = new Promise((resolve) => { releaseClientRequests = resolve; });\n\t\t\t};\n\t\t\tconst finishClientRequestWindow = () => {\n\t\t\t\tconst release = releaseClientRequests;\n\t\t\t\tclientRequestWindow = undefined;\n\t\t\t\treleaseClientRequests = undefined;\n\t\t\t\trelease?.();\n\t\t\t};\n\t\t\tconst installClientRequestGate = () => {\n\t\t\t\tif (api.context.action !== "dev" || rscEnabled || !concurrentDev) return;\n\t\t\t\tconst environment = devServerRef?.environments[RSBUILD_ENVIRONMENT_NAMES.server];\n\t\t\t\tif (!environment || requestGateEnvironments.has(environment)) return;\n\t\t\t\tconst loadBundle = environment.loadBundle;\n\t\t\t\tenvironment.loadBundle = async function(...args) {\n\t\t\t\t\twhile (clientRequestWindow) await clientRequestWindow;\n\t\t\t\t\tconst bundle = await loadBundle.apply(this, args);\n\t\t\t\t\twhile (clientRequestWindow) await clientRequestWindow;\n\t\t\t\t\treturn bundle;\n\t\t\t\t};\n\t\t\t\trequestGateEnvironments.add(environment);\n\t\t\t};\n\t\t\tif (api.context.action === "dev" && !rscEnabled) {\n\t\t\t\tapi.onBeforeStartDevServer(({ server }) => {\n\t\t\t\t\tdevServerRef = server;\n\t\t\t\t\tinstallClientRequestGate();\n\t\t\t\t});\n\t\t\t}\n\t\t\tif (api.context.action === "dev" && !rscEnabled) api.onAfterEnvironmentCompile({ order: "post", handler: ({ environment, stats }) => {\n\t\t\t\t\tif (!concurrentDev || environment.name !== RSBUILD_ENVIRONMENT_NAMES.client) return;\n\t\t\t\t\tif (stats.hasErrors()) finishClientRequestWindow();\n\t\t\t\t\telse if (getClientBuild() && compilingClientRequestRevision === clientRequestRevision) finishClientRequestWindow();\n\t\t\t\t} });\n'+'\t\t\tif (rscEnabled) api.onAfterCreateCompiler')
  anchor='\t\t\t\t\t\tserverCompiler.hooks.done.tap({ name: "TanStackStartSsrRevisionCheck", stage: 1000 }, () => {\n\t\t\t\t\t\t\tif (ssrResolverRevision !== virtualModuleState.getResolverWriteRevision(serverFnProviderEnv)) invalidateSsr();\n\t\t\t\t\t\t});\n'
  assert anchor in new
  new=new.replace(anchor,anchor+'\t\t\t\t\t\tclientCompiler.hooks.invalid.tap("TanStackStartClientRequestGate", beginClientRequestWindow);\n\t\t\t\t\t\tclientCompiler.hooks.watchRun.tap({ name: "TanStackStartClientRequestGate", stage: -1000 }, () => {\n\t\t\t\t\t\t\tif (!clientRequestWindow) beginClientRequestWindow();\n\t\t\t\t\t\t\tcompilingClientRequestRevision = clientRequestRevision;\n\t\t\t\t\t\t});\n\t\t\t\t\t\tclientCompiler.hooks.done.tap({ name: "TanStackStartClientRequestGate", stage: 2000 }, (stats) => {\n\t\t\t\t\t\t\tif (stats.hasErrors()) finishClientRequestWindow();\n\t\t\t\t\t\t});\n\t\t\t\t\t\tclientCompiler.hooks.failed.tap("TanStackStartClientRequestGate", finishClientRequestWindow);\n\t\t\t\t\t\tclientCompiler.hooks.watchClose.tap("TanStackStartClientRequestGate", finishClientRequestWindow);\n\t\t\t\t\t\tbeginClientRequestWindow();\n\t\t\t\t\t\tinstallClientRequestGate();\n')
  new=new.replace('compiler.setDependencies(serverCompiler, dependencies);', 'compiler.setDependencies(serverCompiler, userDependency ? [...new Set([...(compiler.dependencies?.get(serverCompiler) ?? []), ...(serverCompiler.options.dependencies ?? []), ...dependencies])] : dependencies);')
 else:
  new=new.replace('if (!opts.rscEnabled) {\n\t\t\tconst writeModule', 'if (isDev && !opts.rscEnabled) {\n\t\t\tconst writeModule')
 for name,start,end in ([('compiler barriers','\t\t\t\t\t\tconcurrentDev = true;','\t\t\t\t\t\tlogConcurrencyState' ),('before topology','', '\t\t\tconst logConcurrencyState'),('after topology','\t\t\tif (api.context.action !== "dev" && rscEnabled)',None)] if file=='plugin.js' else []):
  def region(s,is_new):
   a=s.index(start) if start else 0
   if name=='compiler barriers' and is_new:b=s.index('\t\t\t\t\t\tclientCompiler.hooks.invalid.tap("TanStackStartClientRequestGate"',a)
   else:b=s.index(end,a) if end else len(s)
   return s[a:b]
  before=region(old,False);after=region(new,True)
  proof.append(dict(file=file,region=name,equal=before==after,beforeSha256=hashlib.sha256(before.encode()).hexdigest(),afterSha256=hashlib.sha256(after.encode()).hexdigest()))
 (output/file).write_text(new)
 patches.extend(difflib.unified_diff(stock.splitlines(keepends=True),new.splitlines(keepends=True),fromfile='a/dist/esm/rsbuild/'+file,tofile='b/dist/esm/rsbuild/'+file))
patch.write_text(''.join(patches))
(output/'v2-partition-proof.json').write_text(json.dumps(proof,indent=2))
print(hashlib.sha256(patch.read_bytes()).hexdigest())
