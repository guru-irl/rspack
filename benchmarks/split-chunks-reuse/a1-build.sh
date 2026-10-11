#!/usr/bin/env bash
set -euo pipefail
WORKSPACE="$GITHUB_WORKSPACE"
RESULTS="$WORKSPACE/.spider/scratch/split-chunks-name-once/build"
mkdir -p "$RESULTS" "$RESULTS/tmp" "$WORKSPACE/source-artifacts"
export TMPDIR="$RESULTS/tmp"
cd "$WORKSPACE/source"
export CARGO_TARGET_DIR="$PWD/target"
arms='main main-a1'
if [[ "$RUNNER_OS" == Linux ]]; then arms='main main-a1 batch batch-a1'; fi
for arm in $arms; do
  case "$arm" in
    main) ref=f2903b6482cb7a0fcdca912d23062bd94d3d5636 ;;
    main-a1) ref=8b0380ac0b49e68aadbec5a262e6c4e251c76acd ;;
    batch) ref=8b5ea6ac2eb404148499f243226fc631ed16d6a9 ;;
    batch-a1) ref=078b389917dcc17c804569e2f96dfdb27264b04a ;;
  esac
  # Disposable hosted checkout only. Restore bench instrumentation/generated
  # tracked files before switching arms; refresh mtimes to defeat stale Cargo
  # artifacts when swapping same-name/same-version crate sources.
  git restore --source=HEAD --staged --worktree .
  rm -f crates/rspack_plugin_split_chunks/src/plugin/a1_timing.rs
  git checkout --detach "$ref"
  python - <<'PY'
from pathlib import Path
import os
for directory in ['crates/rspack_plugin_split_chunks/src', 'crates/node_binding/src']:
    for file in Path(directory).rglob('*.rs'):
        os.utime(file, None)
PY
  {
    echo "SOURCE $arm $ref TARGET $RUST_TARGET"
    df -h .
    pnpm install --frozen-lockfile
    cargo codegen
    pnpm run build:binding:release
    pnpm --filter @rspack/core run build
  } 2>&1 | tee "$RESULTS/$arm-release.log"
  dest="$WORKSPACE/source-artifacts/$arm"
  mkdir -p "$dest/core" "$dest/binding"
  cp -a packages/rspack/dist packages/rspack/compiled "$dest/core/"
  cp crates/node_binding/binding.js crates/node_binding/*.node "$dest/binding/"
  git rev-parse HEAD > "$dest/head.txt"
  echo "$ref" > "$dest/base.txt"
  cp "$dest/head.txt" "$RESULTS/$arm-head.txt"
  rustc -Vv > "$RESULTS/$arm-toolchain.txt"
  if [[ "$RUNNER_OS" == Linux ]]; then
    python "$WORKSPACE/benchmarks/split-chunks-reuse/instrument-a1.py" .
    pnpm run build:binding:release 2>&1 | tee "$RESULTS/$arm-timing.log"
    mkdir -p "$dest/timing"
    cp crates/node_binding/*.node "$dest/timing/"
  fi
done
# Build jobs are over before any samples. Remove target to reclaim runner disk,
# not the bindings consumed below. Uploaded artifacts never include these.
rm -rf "$CARGO_TARGET_DIR"
