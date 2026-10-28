#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD/.bench-stable-absence"
mkdir -p "$ROOT/scripts" "$ROOT/tmp" "$ROOT/fixture" "$ROOT/stock-fixture" "$ROOT/results"
cp scripts/stable-absence-bench/* "$ROOT/scripts/"
export TMPDIR="$ROOT/tmp"
pnpm install --frozen-lockfile > "$ROOT/results/install.log" 2>&1
pnpm run build:js > "$ROOT/results/js-build.log" 2>&1
node "$ROOT/scripts/prepare.mjs" "$ROOT/stock-fixture"
node "$ROOT/scripts/prepare.mjs" "$ROOT/fixture"
node "$ROOT/scripts/add-barrel.mjs" "$ROOT/fixture"
python "$ROOT/scripts/paired_stats.py"
python "$ROOT/scripts/series.py" "$ROOT" "$PWD"
