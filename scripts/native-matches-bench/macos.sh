#!/bin/bash
set -euo pipefail
test "$(uname -m)" = arm64
ROOT=$PWD/.bench-native-matches-live-heap
mkdir -p "$ROOT/scripts" "$ROOT/artifacts/base" "$ROOT/artifacts/change" "$ROOT/tmp"
cp scripts/native-matches-bench/* "$ROOT/scripts/"
BASE=$(< "$ROOT/scripts/base.sha")
CHANGE=$(< "$ROOT/scripts/change.sha")
export TMPDIR=$ROOT/tmp CARGO_TARGET_DIR=$ROOT/target CARGO_BUILD_JOBS=3
export RUSTUP_TOOLCHAIN=nightly-2026-04-16-aarch64-apple-darwin
unset RAYON_NUM_THREADS TOKIO_WORKER_THREADS RSPACK_BINDING RSPACK_LIVE_HEAP_LOG
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
python3 "$ROOT/scripts/series.py" "$ROOT" "$PWD/packages/rspack"
# Upload synthetic records and logs only, not multi-GB binaries or fixtures.
rm -rf "$ROOT/target" "$ROOT/fixture/src" "$ROOT/fixture/dist" "$ROOT/artifacts/base/binding.node" "$ROOT/artifacts/change/binding.node"
