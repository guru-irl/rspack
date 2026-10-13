#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD/.bench-split-chunks-option-b"
mkdir -p "$ROOT/scripts" "$ROOT/tmp" "$ROOT/fixture" "$ROOT/results"
cp scripts/split-chunks-option-b-bench/* "$ROOT/scripts/"
export TMPDIR="$ROOT/tmp"
pnpm install --frozen-lockfile > "$ROOT/results/install.log" 2>&1
pnpm run build:js > "$ROOT/results/js-build.log" 2>&1
cp "$ROOT/scripts/run.mjs" "$ROOT/scripts/gen.mjs" "$ROOT/fixture/"
node "$ROOT/fixture/gen.mjs" --modules 60000
python "$ROOT/scripts/paired_stats.py"
python "$ROOT/scripts/series.py" "$ROOT" "$PWD"
