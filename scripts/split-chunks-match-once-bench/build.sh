#!/usr/bin/env bash
set -euo pipefail
BASE=f2903b6482cb7a0fcdca912d23062bd94d3d5636
CHANGE=61d3704f6feafb8b7f0ab93fc569f76a78b2b8e5
ROOT=$PWD/.bench-split-chunks-match-once
mkdir -p "$ROOT/scripts" "$ROOT/bindings/base" "$ROOT/bindings/change" "$ROOT/tmp" "$ROOT/fixture"
cp scripts/split-chunks-match-once-bench/* "$ROOT/scripts/"
export TMPDIR="$ROOT/tmp" CARGO_TARGET_DIR="$ROOT/target" CARGO_BUILD_JOBS=3
unset RSPACK_BINDING RAYON_NUM_THREADS TOKIO_WORKER_THREADS
cleanup() { rm -rf "$ROOT/target" "$ROOT/fixture/src" "$ROOT/fixture/dist" "$ROOT/bindings/base/binding.node" "$ROOT/bindings/change/binding.node"; }
trap cleanup EXIT
if [[ "$RUNNER_OS" == macOS ]]; then
  test "$(uname -m)" = arm64
  BINDING=rspack.darwin-arm64.node
else
  BINDING=rspack.win32-x64-msvc.node
fi
rustup toolchain install nightly-2026-04-16 --profile minimal --component rust-src
printf '%s\n' "$BASE" > "$ROOT/bindings/base/commit.sha"
printf '%s\n' "$CHANGE" > "$ROOT/bindings/change/commit.sha"
git switch --detach "$BASE"
pnpm install --frozen-lockfile > "$ROOT/install.log" 2>&1
pnpm run build:js > "$ROOT/base-js.log" 2>&1
pnpm --dir crates/node_binding run build:ci > "$ROOT/base-build.log" 2>&1
cp "crates/node_binding/$BINDING" "$ROOT/bindings/base/binding.node"
git switch --detach "$CHANGE"
touch crates/rspack_plugin_split_chunks/src/plugin/{mod,module_group}.rs
pnpm --dir crates/node_binding run build:ci > "$ROOT/change-build.log" 2>&1
cp "crates/node_binding/$BINDING" "$ROOT/bindings/change/binding.node"
cp "$ROOT/scripts/run.mjs" "$ROOT/scripts/gen.mjs" "$ROOT/fixture/"
node "$ROOT/fixture/gen.mjs" --modules 60000
python "$ROOT/scripts/paired_stats.py"
python "$ROOT/scripts/series.py" "$ROOT" "$PWD/packages/rspack"
