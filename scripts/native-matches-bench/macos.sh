#!/bin/bash
set -euo pipefail
test "$(uname -m)" = arm64
BASE=60fd7496544878aea7aca8bd2d876d7518297c08
CHANGE=$(cat scripts/native-matches-bench/change.sha)
ROOT=$PWD/.bench-native-matches
mkdir -p "$ROOT/scripts" "$ROOT/artifacts/base" "$ROOT/artifacts/change" "$ROOT/tmp"
cleanup() { rm -rf "$ROOT/target" "$ROOT/fixture/src" "$ROOT/fixture/dist" "$ROOT/artifacts/base/binding.node" "$ROOT/artifacts/change/binding.node"; }
trap cleanup EXIT
cp scripts/native-matches-bench/* "$ROOT/scripts/"
export TMPDIR=$ROOT/tmp CARGO_TARGET_DIR=$ROOT/target CARGO_BUILD_JOBS=3
export RUSTUP_TOOLCHAIN=nightly-2026-04-16-aarch64-apple-darwin
unset RAYON_NUM_THREADS TOKIO_WORKER_THREADS RSPACK_BINDING
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal
printf '%s\n' "$BASE" > "$ROOT/artifacts/base/commit.sha"
printf '%s\n' "$CHANGE" > "$ROOT/artifacts/change/commit.sha"
git switch --detach "$BASE"
pnpm install --frozen-lockfile
pnpm run build:js > "$ROOT/base-js.log" 2>&1
pnpm --dir crates/node_binding run build:ci > "$ROOT/base-build.log" 2>&1
cp crates/node_binding/rspack.darwin-arm64.node "$ROOT/artifacts/base/binding.node"
git switch --detach "$CHANGE"
touch crates/rspack_plugin_split_chunks/src/plugin/{mod,module_group}.rs
pnpm --dir crates/node_binding run build:ci > "$ROOT/change-build.log" 2>&1
cp crates/node_binding/rspack.darwin-arm64.node "$ROOT/artifacts/change/binding.node"
mkdir -p "$ROOT/fixture"
cp "$ROOT/scripts/gen.mjs" "$ROOT/scripts/run.mjs" "$ROOT/fixture/"
node "$ROOT/fixture/gen.mjs" --modules 60000
python3 "$ROOT/scripts/macos-series.py" "$ROOT" "$PWD/packages/rspack"
# Keep only public synthetic measurements, not multi-GB build artifacts.
rm -rf "$ROOT/target" "$ROOT/fixture/src" "$ROOT/fixture/dist" "$ROOT/artifacts/base/binding.node" "$ROOT/artifacts/change/binding.node"
