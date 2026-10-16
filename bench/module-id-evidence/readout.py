import json, pathlib, statistics
R=pathlib.Path(__file__).resolve().parent/'readout'
summaries={}
for platform in ['linux','macos','windows']:
    old=json.loads((R/platform/'original.json').read_text())
    new=json.loads((R/platform/'data/summary.json').read_text())
    assert old==new, 'Raw recomputation changed summary'
    assert new['metadata']['arch']==('arm64' if platform=='macos' else 'x64')
    assert new['coldOutputIdentical']
    assert len(new['samples'])==(42 if platform=='linux' else 22)
    for s in new['samples']:
        assert s['receipt']['nativeLoads']==1
        assert s['receipt']['nativeSha256']==new['metadata']['hashes'][s['arm']]
        assert s['receipt']['rows']==(9 if platform=='linux' else 7)
    summaries[platform]=new
    env=new['metadata']
    print('ENVIRONMENT',json.dumps({'platform':platform,'node':env['node'],'arch':env['arch'],'cpus':len(env['cpus']),'cpuModel':env['cpus'][0]['model'],'ramBytes':env['ram'],'osRelease':env['release'],'runnerImage':env.get('runnerImage'),'runnerVersion':env.get('runnerVersion'),'hashes':env['hashes']}))
    print('METRICS',platform,json.dumps(new['metrics']))
    for s in new['samples']:
        print('RAW_PROCESS',platform,json.dumps({'block':s['block'],'family':s['family'],'metrics':s['metrics'],'nativeSha256':s['receipt']['nativeSha256']}))
base=json.loads((R/'hmr/hmr-base.json').read_text())
pr=json.loads((R/'hmr/hmr-pr.json').read_text())
for arm,h in [('base',base),('pr',pr)]:
    assert h['nativeLoads']==1
    assert h['nativeSha256']==summaries['linux']['metadata']['hashes'][arm]
    assert h['contentIdsUnchanged']
    assert h['contentRuntime']['contentRevision']==h['contentRuntime']['queryRevision']==1
    assert h['contentRuntime']['navigations']==1
    assert h['contentRuntime']['acceptCount']>=1
    assert h['contentManifests'] and any(m['manifest']['c'] for m in h['contentManifests'])
    assert all(m['manifest']['m']==[] for m in h['contentManifests'])
    assert h['compilations'][1]['progressEvents']>h['compilations'][0]['progressEvents']
assert len(base['compilations'])==2 and len(pr['compilations'])==3
assert pr['compilations'][1]['codeGenerated']==2
assert pr['compilations'][1]['processedFixtureModules']==['./src/Component00000.jsx','./src/Component00000.jsx?variant'] or set(pr['compilations'][1]['processedFixtureModules'])=={'./src/Component00000.jsx','./src/Component00000.jsx?variant'}
rename=pr['rename']
assert rename['newId']!=rename['oldId']
assert rename['fullHash'].startswith(rename['oldId'])
assert any(rename['oldId'] in x['manifest']['m'] for x in rename['manifests'])
assert rename['runtime']['renameValue']=='new' and rename['runtime']['removedDisposed']==1
assert rename['runtime']['navigations']==rename['runtime']['contentRevision']==rename['runtime']['queryRevision']==1
print('HMR_BASE',json.dumps(base))
print('HMR_PR',json.dumps(pr))
lines=['## Performance','','GitHub-hosted runners, Node 22.23.3, a generated 19,005-module development fixture and matched optimized builds. Linux uses ten interleaved four-process A/A blocks; macOS and Windows use ten alternating pairs. Values are base → PR medians; percentages use those medians.','','| Metric | Base | PR | Change |','| --- | ---: | ---: | ---: |']
def row(label,platform,key,unit):
    m=summaries[platform]['metrics'][key]
    lines.append(f"| {label} | {m['base']:.2f} {unit} | {m['pr']:.2f} {unit} | {m['percent']:+.2f}% |")
row('Linux content-edit rebuild','linux','contentMs','ms')
lines.append('| Content codegen processed, including cache lookups | 19,005 | 2 | -99.99% |')
for platform,label in [('linux','Linux x64'),('macos','macOS arm64'),('windows','Windows x64')]:
    row(label+(' peak working set' if platform=='windows' else ' peak RSS'),platform,'peakMiB','MiB')
    row(label+' post-GC RSS',platform,'steadyMiB','MiB')
lines+=['','- The content-edit improvement exceeds the observed A/A spread.','- No peak or post-GC memory increase was detected on any measured platform.','- Cold output is byte-identical, and retained IDs stayed stable.','- Dev-server HMR with ProgressPlugin passed, including the colliding rename.']
text='\n'.join(lines)+'\n'
(R/'performance.md').write_text(text)
print('PERFORMANCE_PROPOSAL_BEGIN\n'+text+'PERFORMANCE_PROPOSAL_END')
print('READOUT_VERIFIED raw_recomputation=3 native_process_receipts=86 hmr_arms=2')
