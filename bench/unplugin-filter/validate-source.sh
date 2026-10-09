#!/usr/bin/env bash
set -euo pipefail
base="$GITHUB_WORKSPACE/bench/unplugin-filter"
logs="$base/source-results"
mkdir -p "$logs"
git clone https://github.com/unjs/unplugin.git "$GITHUB_WORKSPACE/unplugin-source"
cd "$GITHUB_WORKSPACE/unplugin-source"
git checkout f2acf00e1f8e4fbeaa28f6660545c70c43cb2d73
git rev-parse HEAD > "$logs/main-sha.txt"
git apply --check "$base/unplugin-filters-once-src.patch"
git apply "$base/unplugin-filters-once-src.patch"
npm install -g pnpm@12.5.0 --registry=https://registry.npmjs.org
pnpm install --frozen-lockfile > "$logs/install.log" 2>&1
pnpm run lint:fix > "$logs/lint-fix.log" 2>&1
pnpm run lint > "$logs/lint.log" 2>&1
git diff -- src test/unit-tests > "$logs/unplugin-filters-once-src.patch"
pnpm run build > "$logs/build.log" 2>&1
pnpm run typecheck > "$logs/typecheck.log" 2>&1
pnpm test --reporter=json --outputFile="$logs/full-test.json" > "$logs/full-test.log" 2>&1
python3 - "$logs" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
d = json.loads((root / 'full-test.json').read_text())
counts = {k: d[k] for k in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTotalTestSuites', 'numPassedTestSuites']}
assert d['success'] and counts['numFailedTests'] == 0
counts.update({'install': 'pass', 'build': 'pass', 'typecheck': 'pass', 'lint': 'pass', 'full_pnpm_test': 'pass'})
(root / 'validation.json').write_text(json.dumps(counts, indent=2))
print(json.dumps(counts, indent=2))
PY
