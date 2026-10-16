from pathlib import Path
import difflib,sys,shutil
work=Path(sys.argv[1]); target=Path(sys.argv[2]);target.mkdir(parents=True,exist_ok=True)
src=work/'v3/dist/esm/rsbuild/plugin.js';s=src.read_text()
def replace(a,b):
 global s
 assert s.count(a)==1,(a,s.count(a))
 s=s.replace(a,b)
replace('const coldAfterMake = coldOverlapMode === "after-make";', 'const coldAfterMake = coldOverlapMode === "after-make";\n\tconst coldAfterSeal = coldOverlapMode === "after-seal";\n\tconst coldAfterEmit = coldOverlapMode === "after-emit";\n\tconst coldAfterClientPhase = coldAfterMake || coldAfterSeal || coldAfterEmit;')
replace('["0", "after-make", "1"]','["0", "after-make", "after-seal", "after-emit", "1"]')
replace('${coldAfterMake ? "after-make" : coldOverlap ? "1" : "default"}', '${coldAfterClientPhase ? coldOverlapMode : coldOverlap ? "1" : "default"}')
a='\t\t\t\t\t\tclientCompiler.hooks.failed.tap("TanStackStartClientManifestBarrier", (error) => rejectFirstClientManifest(error));'
b='''						if (coldAfterSeal || coldAfterEmit) {
							const releaseColdPhase = () => {
								clientMakeComplete = true;
								releaseFirstClientMake();
							};
							if (coldAfterSeal) clientCompiler.hooks.thisCompilation.tap("TanStackStartClientColdPhaseBarrier", (compilation) => {
								if (compilation.compiler !== clientCompiler) return;
								compilation.hooks.afterSeal.tap("TanStackStartClientColdPhaseBarrier", releaseColdPhase);
							});
							if (coldAfterEmit) clientCompiler.hooks.afterEmit.tap("TanStackStartClientColdPhaseBarrier", (compilation) => {
								if (compilation.compiler === clientCompiler) releaseColdPhase();
							});
							// A run may end without sealing or emitting. Never strand SSR.
							for (const hook of ["done", "failed", "watchClose", "invalid"]) clientCompiler.hooks[hook].tap("TanStackStartClientColdPhaseBarrier", releaseColdPhase);
						}
'''+a
replace(a,b)
replace('if (compilation.compiler !== clientCompiler) return;\n\t\t\t\t\t\t\tclientMakeComplete = true;', 'if (compilation.compiler !== clientCompiler || coldAfterSeal || coldAfterEmit) return;\n\t\t\t\t\t\t\tclientMakeComplete = true;')
replace('if (coldAfterMake && !clientMakeComplete)', 'if (coldAfterClientPhase && !clientMakeComplete)')
replace('else if (!coldOverlap && !coldAfterMake && !clientManifestPublished)', 'else if (!coldOverlap && !coldAfterClientPhase && !clientManifestPublished)')
replace('(coldOverlap || coldAfterMake || ssrResolverRevision >= 0)', '(coldOverlap || coldAfterClientPhase || ssrResolverRevision >= 0)')
v4=work/'v4/dist/esm/rsbuild';v4.mkdir(parents=True,exist_ok=True)
(v4/'plugin.js').write_text(s);shutil.copyfile(work/'v3/dist/esm/rsbuild/virtual-modules.js',v4/'virtual-modules.js')
patch='';inter=''
for name in ['plugin.js','virtual-modules.js']:
 label='dist/esm/rsbuild/'+name
 after=(v4/name).read_text().splitlines(True)
 patch+=''.join(difflib.unified_diff((work/'pristine'/label).read_text().splitlines(True),after,fromfile='a/'+label,tofile='b/'+label))
 inter+=''.join(difflib.unified_diff((work/'v3'/label).read_text().splitlines(True),after,fromfile='v3/'+label,tofile='v4/'+label))
(target/'start-plugin-core-1.171.46-combined.patch').write_text(patch)
(target/'v3-to-v4.interdiff').write_text(inter)
