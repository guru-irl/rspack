#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RESULTS="$GITHUB_WORKSPACE/.spider/scratch/split-chunks-combinator/results"
mkdir -p "$RESULTS" "$GITHUB_WORKSPACE/.spider/scratch/split-chunks-combinator/tmp"
export TMPDIR="$GITHUB_WORKSPACE/.spider/scratch/split-chunks-combinator/tmp"
export NODE_OPTIONS=--max-old-space-size=8192
uname -a > "$RESULTS/host.txt"
lscpu >> "$RESULTS/host.txt"
free -b >> "$RESULTS/host.txt"
for block in 1 2 3 4 5; do
  arms='default-off default-on many-winner-off many-winner-on'
  if (( block % 2 == 0 )); then arms='many-winner-on many-winner-off default-on default-off'; fi
  for arm in $arms; do
    build="${arm##*-}"
    export SHAPE="${arm%-*}" SELECTORS=js
    source="$GITHUB_WORKSPACE/source-artifacts/$build"
    core="$HERE/node_modules/@rspack/core"
    binding="$HERE/node_modules/@rspack/binding"
    rm -rf "$core/dist" "$core/compiled"
    cp -a "$source/core/dist" "$source/core/compiled" "$core/"
    cp "$source/binding/binding.js" "$binding/binding.js"
    export NAPI_RS_NATIVE_LIBRARY_PATH="$source/binding/rspack.linux-x64-gnu.node"
    export SOURCE_BASE="$(< "$source/base.txt")" SOURCE_HEAD="$(< "$source/head.txt")"
    export FIXTURE_ROOT="$GITHUB_WORKSPACE/.spider/scratch/split-chunks-combinator/run-$arm-$block"
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
    rm -rf "$FIXTURE_ROOT"
    echo "VALID $arm block $block"
  done
done
