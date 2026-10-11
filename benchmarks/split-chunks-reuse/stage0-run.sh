#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RESULTS="$GITHUB_WORKSPACE/.spider/scratch/split-chunks-reuse/stage0-results"
mkdir -p "$RESULTS" "$GITHUB_WORKSPACE/.spider/scratch/split-chunks-reuse/tmp"
export TMPDIR="$GITHUB_WORKSPACE/.spider/scratch/split-chunks-reuse/tmp"
export NODE_OPTIONS=--max-old-space-size=8192
uname -a > "$RESULTS/host.txt"
lscpu >> "$RESULTS/host.txt"
free -b >> "$RESULTS/host.txt"
cp "$HERE/package-lock.json" "$RESULTS/package-lock.json"
cp -a "$HERE/node_modules/@rspack/core" "$HERE/stock-core"
cp -a "$HERE/node_modules/@rspack/binding" "$HERE/stock-binding"
for block in 1 2 3 4 5; do
  arms='A B1 B2 C D C2 D2'
  if (( block % 2 == 0 )); then arms='D2 C2 D C B2 B1 A'; fi
  for arm in $arms; do
    core="$HERE/node_modules/@rspack/core"
    binding="$HERE/node_modules/@rspack/binding"
    # These are disposable installed packages on the hosted runner only.
    rm -rf "$core/dist" "$core/compiled"
    if [[ "$arm" == A || "$arm" == B1 || "$arm" == B2 ]]; then
      cp -a "$HERE/stock-core/dist" "$core/"
      cp -a "$HERE/stock-core/compiled" "$core/"
      cp "$HERE/stock-binding/binding.js" "$binding/binding.js"
      unset NAPI_RS_NATIVE_LIBRARY_PATH SOURCE_BASE SOURCE_HEAD
    else
      build=main; [[ "$arm" == D || "$arm" == D2 ]] && build=batch
      source="$GITHUB_WORKSPACE/source-artifacts/$build"
      cp -a "$source/core/dist" "$core/"
      cp -a "$source/core/compiled" "$core/"
      cp "$source/binding/binding.js" "$binding/binding.js"
      export NAPI_RS_NATIVE_LIBRARY_PATH="$source/binding/rspack.linux-x64-gnu.node"
      export SOURCE_BASE="$(< "$source/base.txt")" SOURCE_HEAD="$(< "$source/head.txt")"
    fi
    export SELECTORS=js
    [[ "$arm" == B1 ]] && export SELECTORS=native-membership
    [[ "$arm" == B2 || "$arm" == C2 || "$arm" == D2 ]] && export SELECTORS=native-only
    export FIXTURE_ROOT="$GITHUB_WORKSPACE/.spider/scratch/split-chunks-reuse/run-$arm-$block"
    export SAMPLES=4 WARMUPS=2
    mkdir -p "$FIXTURE_ROOT/results"
    echo "BEGIN $arm block $block"
    set +e
    /usr/bin/time -v node "$HERE/fixture.mjs" > "$FIXTURE_ROOT/results/stdout.log" 2> "$FIXTURE_ROOT/results/stderr.log"
    rc=$?
    set -e
    printf '%s\n' "$rc" > "$FIXTURE_ROOT/results/exit-code.txt"
    mv "$FIXTURE_ROOT/results" "$RESULTS/$arm-$block"
    if (( rc != 0 )); then tail -60 "$RESULTS/$arm-$block/stderr.log"; exit "$rc"; fi
    # Keep raw evidence; remove generated sources/assets before the next arm.
    rm -rf "$FIXTURE_ROOT"
    echo "VALID $arm block $block"
  done
done
