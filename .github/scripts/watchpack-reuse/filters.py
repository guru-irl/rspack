from pathlib import Path

changes = [
    ('packages/rspack-test-tools/src/test/creator.ts',
     'return name.includes(global.testFilter);',
     'return new RegExp(global.testFilter).test(name);'),
    ('packages/rspack-test-tools/src/case/compiler.ts',
     '''description: () =>
          caseConfig.name
            ? `${caseName}: ${caseConfig.description}`
            : caseConfig.description,''',
     'description: () => `${caseName}: ${caseConfig.description}`,'),
    ('packages/rspack-test-tools/src/case/multi-compiler.ts',
     'description: () => caseConfig.description,',
     'description: () => `${name}[${i}]: ${caseConfig.description}`,'),
]
for file, old, new in changes:
    p = Path(file)
    s = p.read_text()
    assert s.count(old) == 1, file
    p.write_text(s.replace(old, new))
print('Workflow-only test selection uses matching path regexes and display names.')
