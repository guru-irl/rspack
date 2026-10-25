from pathlib import Path
p = Path('packages/rspack/src/Watching.ts')
s = p.read_text()
for field, kind in [('fileDependencies', 'files'), ('contextDependencies', 'directories'), ('missingDependencies', 'missing')]:
    declaration = f'          const {field} = new Set(['
    assert s.count(declaration) == 1, field
    s = s.replace(declaration, f'          const {kind}MaterializationStart = performance.now();\n' + declaration)
    assignment = f'          {field}.added = '
    assert s.count(assignment) == 1, field
    callback = f'          (globalThis as any).__watchpackMaterialization?.("{kind}", performance.now() - {kind}MaterializationStart);\n'
    s = s.replace(assignment, callback + assignment)
p.write_text(s)
