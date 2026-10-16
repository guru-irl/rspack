#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT/../.."
mkdir -p "$ROOT/data"
for trial in 0 1 2 3 4; do
  for offset in 0 1 2; do
    arm_index=$(((trial + offset) % 3))
    case "$arm_index" in
      0) arm=main; ids=compact-hashed; native="$ROOT/baseline/rspack.linux-x64-gnu.node" ;;
      1) arm=branch; ids=compact-hashed; native="$ROOT/treatment/rspack.linux-x64-gnu.node" ;;
      2) arm=named; ids=named; native="$ROOT/baseline/rspack.linux-x64-gnu.node" ;;
    esac
    echo "BEGIN $arm block $trial $(date -u +%FT%TZ)"
    ARM_LABEL="$arm" MODULE_IDS="$ids" TRIALS=1 TRIAL_INDEX="$trial" BENCH_TAG="$arm-$trial" NAPI_RS_NATIVE_LIBRARY_PATH="$native" node --expose-gc "$ROOT/benchmark.cjs" > "$ROOT/data/$arm-$trial.log" 2>&1
    echo "END $arm block $trial $(date -u +%FT%TZ)"
  done
done
python3 "$ROOT/summarize.py"
