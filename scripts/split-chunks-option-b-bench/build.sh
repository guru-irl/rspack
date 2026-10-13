#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD/.bench-split-chunks-option-b"
mkdir -p "$ROOT/artifact/core" "$ROOT/tmp"
export TMPDIR="$ROOT/tmp" CARGO_TARGET_DIR="$ROOT/target" CARGO_BUILD_JOBS=3
unset RSPACK_BINDING NAPI_RS_NATIVE_LIBRARY_PATH RAYON_NUM_THREADS TOKIO_WORKER_THREADS
{ uname -a; node --version; pnpm --version; df -h .; } > "$ROOT/artifact/host.txt"
rustup toolchain install nightly-2026-04-16 --profile minimal --component rust-src
rustup default nightly-2026-04-16
rustup target add "$RUST_TARGET"
git switch --detach "$SOURCE_REF"
git rev-parse HEAD > "$ROOT/artifact/commit.sha"
test "$(git rev-parse HEAD)" = "$SOURCE_REF"
pnpm install --frozen-lockfile > "$ROOT/artifact/install.log" 2>&1
cargo codegen > "$ROOT/artifact/codegen.log" 2>&1
printf '\ntrim-paths = true\n' >> .cargo/config.toml
pnpm run build:js > "$ROOT/artifact/js-build.log" 2>&1
if [[ "$RUNNER_OS" == Linux ]]; then
 export USE_NAPI_CROSS=1 TARGET_CC=clang
fi
pnpm run build:binding:release > "$ROOT/artifact/release-build.log" 2>&1
case "$RUNNER_OS" in
 Linux) BINDING=rspack.linux-x64-gnu.node;;
 macOS) test "$(uname -m)" = arm64; BINDING=rspack.darwin-arm64.node;;
 Windows) BINDING=rspack.win32-x64-msvc.node;;
esac
cp "crates/node_binding/$BINDING" "$ROOT/artifact/binding.node"
cp -R packages/rspack/dist "$ROOT/artifact/core/"
cp packages/rspack/package.json "$ROOT/artifact/core/"
if [[ "$RUNNER_OS" == Linux ]]; then
 cp "$ROOT/artifact/binding.node" "$ROOT/artifact/stripped.node"
 strip --strip-all "$ROOT/artifact/stripped.node"
 wc -c < "$ROOT/artifact/stripped.node" > "$ROOT/artifact/stripped-bytes.txt"
 rm "$ROOT/artifact/stripped.node"
fi
{ rustc --version --verbose; df -h .; } >> "$ROOT/artifact/host.txt"
