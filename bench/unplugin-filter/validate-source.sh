#!/usr/bin/env bash
set -euo pipefail
base="$GITHUB_WORKSPACE/bench/unplugin-filter"
logs="$base/source-results"
mkdir -p "$logs"
git clone --depth 1 --branch v3.4.0 https://github.com/unjs/unplugin.git "$GITHUB_WORKSPACE/unplugin-source"
cd "$GITHUB_WORKSPACE/unplugin-source"
git rev-parse HEAD > "$logs/tag-sha.txt"
git apply --check "$base/unplugin-filters-once-src.patch"
git apply "$base/unplugin-filters-once-src.patch"
npm install -g pnpm@12.4.2 --registry=https://registry.npmjs.org
pnpm install --frozen-lockfile > "$logs/install.log" 2>&1
pnpm run build > "$logs/build.log" 2>&1
pnpm run typecheck > "$logs/typecheck.log" 2>&1
set +e
pnpm exec vitest run test/unit-tests --reporter=json --outputFile="$logs/patched-unit.json" > "$logs/patched-unit.log" 2>&1
unit_rc=$?
set -e
printf '%s\n' "$unit_rc" > "$logs/patched-unit-exit.txt"
if [ "$unit_rc" -ne 0 ]; then
  git apply -R "$base/unplugin-filters-once-src.patch"
  pnpm run build > "$logs/stock-build.log" 2>&1
  set +e
  pnpm exec vitest run test/unit-tests --reporter=json --outputFile="$logs/stock-unit.json" > "$logs/stock-unit.log" 2>&1
  baseline_rc=$?
  set -e
  printf '%s\n' "$baseline_rc" > "$logs/stock-unit-exit.txt"
  python3 - "$logs" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
def failures(name):
    data = json.loads((root / name).read_text())
    return sorted(assertion['fullName'] for suite in data['testResults'] for assertion in suite['assertionResults'] if assertion['status'] == 'failed')
a, b = failures('patched-unit.json'), failures('stock-unit.json')
assert a and a == b, f'Unexpected source failures: patched={a}, stock={b}'
(root / 'baseline-failures.json').write_text(json.dumps(a, indent=2))
print('Same unit failures on patched source and stock:', a)
PY
  git apply "$base/unplugin-filters-once-src.patch"
  pnpm run build > "$logs/rebuilt.log" 2>&1
fi
cd "$base"
mkdir -p variants/source-built
ln -s "$GITHUB_WORKSPACE/unplugin-source" variants/source-built/package
ln -s "$GITHUB_WORKSPACE/unplugin-source/node_modules" variants/source-built/node_modules
node check-loaders.mjs source-built > "$logs/source-built-loader-check.log" 2>&1
cat "$logs/source-built-loader-check.log"
