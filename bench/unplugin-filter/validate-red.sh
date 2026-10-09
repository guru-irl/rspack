#!/usr/bin/env bash
set -euo pipefail
base="$GITHUB_WORKSPACE/bench/unplugin-filter"
logs="$base/source-results"
mkdir -p "$logs"
git clone https://github.com/unjs/unplugin.git "$GITHUB_WORKSPACE/unplugin-source"
cd "$GITHUB_WORKSPACE/unplugin-source"
git checkout f2acf00e1f8e4fbeaa28f6660545c70c43cb2d73
git rev-parse HEAD > "$logs/main-sha.txt"
npm install -g pnpm@12.5.0 --registry=https://registry.npmjs.org
pnpm install --frozen-lockfile > "$logs/install.log" 2>&1
pnpm run build > "$logs/build.log" 2>&1
git apply "$base/unplugin-filter-test.patch"
set +e
pnpm exec vitest run test/unit-tests/rspack/loaders/transform.test.ts --reporter=json --outputFile="$logs/red.json" > "$logs/red.log" 2>&1
rc=$?
set -e
printf '%s\n' "$rc" > "$logs/red-exit.txt"
python3 - "$logs" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
data = json.loads((root / 'red.json').read_text())
failed = [a for s in data['testResults'] for a in s['assertionResults'] if a['status'] == 'failed']
assert len(failed) == 1 and 'caches lazy filters per hook and cwd' in failed[0]['fullName'], failed
assert any('expected' in x and 'to be 2' in x for x in failed[0]['failureMessages']), failed
print(json.dumps(failed, indent=2))
PY
[ "$rc" -ne 0 ]
