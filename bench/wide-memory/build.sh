#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD/.bench-wide"
mkdir -p "$ROOT/artifact/core" "$ROOT/tmp"
export TMPDIR="$ROOT/tmp" CARGO_TARGET_DIR="$ROOT/target" CARGO_BUILD_JOBS=3 CARGO_INCREMENTAL=0
if [[ "$RUNNER_OS" == Windows ]]; then
 export TMPDIR="$(cygpath -w "$ROOT/tmp")" TEMP="$TMPDIR" TMP="$TMPDIR"
fi
unset RSPACK_BINDING NAPI_RS_NATIVE_LIBRARY_PATH RAYON_NUM_THREADS TOKIO_WORKER_THREADS
{ uname -a; node --version; pnpm --version; df -h .; } > "$ROOT/artifact/host.txt"
cd source
rustup toolchain install nightly-2026-04-16 --profile minimal --component rust-src
rustup default nightly-2026-04-16
rustup target add "$RUST_TARGET"
git rev-parse HEAD > "$ROOT/artifact/commit.sha"
test "$(git rev-parse HEAD)" = "$SOURCE_REF"
pnpm install --frozen-lockfile > "$ROOT/artifact/install.log" 2>&1
cargo codegen > "$ROOT/artifact/codegen.log" 2>&1
printf '\ntrim-paths = true\n' >> .cargo/config.toml
pnpm run build:js > "$ROOT/artifact/js-build.log" 2>&1
if [[ "$RUNNER_OS" == Linux ]]; then
 export USE_NAPI_CROSS=1 TARGET_CC=clang
fi
if [[ "$RUNNER_OS" == macOS ]]; then
 test "$(uname -m)" = arm64
 export CC="$(xcrun -f clang)" CXX="$(xcrun -f clang++)"
 SYSROOT="$(xcrun --sdk macosx --show-sdk-path)"
 export CFLAGS="-isysroot $SYSROOT -isystem $SYSROOT"
fi
pnpm run build:binding:release > "$ROOT/artifact/release-build.log" 2>&1
case "$RUNNER_OS" in
 Linux) BINDING=rspack.linux-x64-gnu.node;;
 macOS) BINDING=rspack.darwin-arm64.node;;
 Windows) BINDING=rspack.win32-x64-msvc.node;;
esac
cp "crates/node_binding/$BINDING" "$ROOT/artifact/binding.node"
cp -R packages/rspack/dist "$ROOT/artifact/core/"
cp packages/rspack/package.json "$ROOT/artifact/core/"
node - "$ROOT/artifact" "$SOURCE_REF" <<'JS'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [root, source] = process.argv.slice(2);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(path.join(root, 'identity.json'), JSON.stringify({source, profile: 'release', features: ['plugin', 'info-level'], platform: process.platform, arch: process.arch, sha256: hash(path.join(root, 'binding.node')), coreIndexHash: hash(path.join(root, 'core/dist/index.js'))}, null, 2));
JS
{ rustc --version --verbose; df -h .; } >> "$ROOT/artifact/host.txt"
