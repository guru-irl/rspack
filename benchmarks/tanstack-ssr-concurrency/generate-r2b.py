"""Re-derive RSC code from pristine; transplant only scoped non-RSC edits."""
import difflib, hashlib, json, sys
from pathlib import Path
pristine, measured, output, patch = map(Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)
def region(text,start,end):
    assert text.count(start)==1, start
    a=text.index(start); b=text.index(end,a+len(start)); return a,b
proof=[];patches=[]
for file in ['plugin.js','virtual-modules.js']:
    stock=(pristine/file).read_text(); old=(measured/("measured-"+file)).read_text()
    if file=='plugin.js':
        bounds=[region(stock,'\t\t\tif (rscEnabled) {','\t\t\tif (!rscEnabled) api.onAfterCreateCompiler'),region(stock,'function rebuildModulesContaining','/**\n* Return the realpath')]
    else:
        bounds=[region(stock,'\t\ttryUpdateServerFnResolver(content) {','\t\tgetVirtualPath'),region(stock,'\tfunction tryWriteModule','\tfunction flushPendingWrites')]
    # Start from pristine. Copy each measured change only if it doesn't intersect
    # an RSC protected region. A later generation step never searches RSC bytes.
    stockLines=stock.splitlines(keepends=True); oldLines=old.splitlines(keepends=True)
    offsets=[0]
    for line in stockLines:offsets.append(offsets[-1]+len(line))
    chunks=[]
    for tag,a,b,c,d in difflib.SequenceMatcher(None,stockLines,oldLines,autojunk=False).get_opcodes():
        protected=any(offsets[a]<y and offsets[b]>x for x,y in bounds)
        chunks.extend(stockLines[a:b] if tag=='equal' or protected else oldLines[c:d])
    new=''.join(chunks)
    if file=='virtual-modules.js':
        # Revision observation belongs only to non-RSC instances; tryWriteModule
        # and every direct updater remain pristine, including their return values.
        start,end=region(new,'\t\tconst vmPlugin = new VMP(initialContent);','\t\tvmPlugins[envName] = vmPlugin;')
        block=new[start:end]
        assert block=='\t\tconst vmPlugin = new VMP(initialContent);\n'
        block+="""		if (!opts.rscEnabled) {
			const writeModule = vmPlugin.writeModule.bind(vmPlugin);
			vmPlugin.writeModule = (filePath, content) => {
				const result = writeModule(filePath, content);
				if (isDev && filePath === paths.serverFnResolver) resolverWriteRevisionByEnvironment[envName] = (resolverWriteRevisionByEnvironment[envName] ?? 0) + 1;
				return result;
			};
		}
"""
        new=new[:start]+block+new[end:]
    # Hash complete partitions, not just selected changed lines.
    if file=='plugin.js':
        oldRsc=region(old,'\t\t\tif (rscEnabled) {','\t\t\tconst logConcurrencyState')
        newRsc=region(new,'\t\t\tif (rscEnabled) {','\t\t\tconst logConcurrencyState')
        parts=[('before RSC branch',old[:oldRsc[0]],new[:newRsc[0]]),('after RSC branch (includes shared helper)',old[oldRsc[1]:],new[newRsc[1]:])]
    else:
        oldDirect=region(old,'\t\ttryUpdateServerFnResolver(content) {','\t\tgetVirtualPath')
        newDirect=region(new,'\t\ttryUpdateServerFnResolver(content) {','\t\tgetVirtualPath')
        parts=[('before RSC direct updater (includes shared write observation)',old[:oldDirect[0]],new[:newDirect[0]]),('after RSC direct updater',old[oldDirect[1]:],new[newDirect[1]:])]
    for name,a,b in parts:proof.append(dict(file=file,region=name,beforeSha256=hashlib.sha256(a.encode()).hexdigest(),afterSha256=hashlib.sha256(b.encode()).hexdigest(),equal=a==b))
    (output/file).write_text(new)
    patches.extend(difflib.unified_diff(stock.splitlines(keepends=True),new.splitlines(keepends=True),fromfile='a/dist/esm/rsbuild/'+file,tofile='b/dist/esm/rsbuild/'+file))
patch.write_text(''.join(patches))
(output/'non-rsc-region-proof.json').write_text(json.dumps({'measurementHead':'67fd504fa122769f2ad5939e1204971335d1d376','regions':proof,'measurementsCarryForward':all(p['equal'] for p in proof)},indent=2))
print(patch,hashlib.sha256(patch.read_bytes()).hexdigest())
print(json.dumps(proof,indent=2))
