#!/usr/bin/env bash
set -euo pipefail
HERE="$GITHUB_WORKSPACE/benchmarks/split-chunks-reuse"
RESULTS="$GITHUB_WORKSPACE/.spider/scratch/next-max-t/results"
export TMPDIR="$GITHUB_WORKSPACE/.spider/scratch/next-max-t/tmp"
export NODE_OPTIONS=--max-old-space-size=8192
export RAYON_NUM_THREADS=4 TOKIO_WORKER_THREADS=4
unset RSPACK_RAYON_SPIN_ROUNDS RSPACK_RAYON_SPIN_MODE RSPACK_RAYON_SPIN_US
mkdir -p "$RESULTS" "$TMPDIR"
uname -a > "$RESULTS/host.txt"
lscpu >> "$RESULTS/host.txt"
free -b >> "$RESULTS/host.txt"
uptime >> "$RESULTS/host.txt"
cd "$HERE"
npm install --ignore-scripts --registry=https://registry.npmjs.org
for block in 1 2 3; do
  # Both builds use the same absolute source/output path; each block has 2 warmups + 2 measured edits.
  arms='baseline diagnostic'; (( block % 2 == 0 )) && arms='diagnostic baseline'
  export ASSET_REFERENCE="$GITHUB_WORKSPACE/.spider/scratch/next-max-t/reference-$block"
  first=1
  for arm in $arms; do
    source="$GITHUB_WORKSPACE/source-artifacts/$arm"
    core="$HERE/node_modules/@rspack/core"
    binding="$HERE/node_modules/@rspack/binding"
    rm -rf "$core/dist" "$core/compiled"
    cp -a "$source/core/dist" "$source/core/compiled" "$core/"
    cp "$source/binding/binding.js" "$binding/binding.js"
    export NAPI_RS_NATIVE_LIBRARY_PATH="$source/binding/rspack.linux-x64-gnu.node"
    export SOURCE_HEAD="$(< "$source/head.txt")" SOURCE_BASE=8aefea23a929df4c500562739b7b994966195108
    export FIXTURE_ROOT="$GITHUB_WORKSPACE/.spider/scratch/next-max-t/run"
    export SELECTORS=js SAMPLES=4 WARMUPS=2 SAVE_ASSET_REFERENCE=$first
    mkdir -p "$FIXTURE_ROOT/results"
    /usr/bin/time -v node "$HERE/fixture.mjs" > "$FIXTURE_ROOT/results/stdout.log" 2> "$FIXTURE_ROOT/results/stderr.log" || { tail -60 "$FIXTURE_ROOT/results/stderr.log"; exit 1; }
    mv "$FIXTURE_ROOT/results" "$RESULTS/$arm-$block"
    rm -rf "$FIXTURE_ROOT"
    first=0
  done
  rm -rf "$ASSET_REFERENCE"
done
python3 "$HERE/next-max-t-summary.py"
