#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD/.bench-split-chunks-option-b"
mkdir -p "$ROOT/tmp" "$ROOT/results"
export TMPDIR="$ROOT/tmp" TMP="$ROOT/tmp" TEMP="$ROOT/tmp" CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=3
unset RSPACK_BINDING NAPI_RS_NATIVE_LIBRARY_PATH RAYON_NUM_THREADS TOKIO_WORKER_THREADS NODE_OPTIONS
pnpm install --frozen-lockfile > "$ROOT/results/install.log" 2>&1
pnpm run build:js > "$ROOT/results/js-build.log" 2>&1
rustup toolchain install nightly-2026-04-16 --profile minimal --component rust-src
rustup default nightly-2026-04-16
rustup target add "$RUST_TARGET"
for arm in restack final; do
 if [[ "$arm" == restack ]]; then REF=95c672a381ed713e582265e637badec09372eda3; else REF=afc02802ce48e5ef83a0b5761d80139a1436f4e5; fi
 git checkout "$REF" -- crates/rspack_watcher
 node - "$ROOT" "$arm" <<'JS'
const fs=require('node:fs'),path=require('node:path');
const [root,arm]=process.argv.slice(2);
const platform={linux:'Linux',darwin:'macOS',win32:'Windows'}[process.platform];
const dest=path.join(root,'bindings',`optb-binding-${platform}-${arm}`,'core');
fs.cpSync('packages/rspack/compiled',path.join(dest,'compiled'),{recursive:true});
fs.symlinkSync(path.resolve('packages/rspack/node_modules'),path.join(dest,'node_modules'),process.platform==='win32'?'junction':'dir');
const lib='crates/rspack_watcher/src/lib.rs';
fs.writeFileSync('crates/rspack_watcher/src/native_watcher_event_cost.rs',fs.readFileSync(lib,'utf8')+'\n'+fs.readFileSync('scripts/split-chunks-option-b-bench/event-cost.rs','utf8'));
fs.appendFileSync('crates/rspack_watcher/Cargo.toml','\n[[bin]]\nname = "native-watcher-event-cost"\npath = "src/native_watcher_event_cost.rs"\n');
JS
 cp crates/rspack_watcher/src/native_watcher_event_cost.rs "$ROOT/results/method-source-$arm.rs"
 git diff -- crates/rspack_watcher/Cargo.toml > "$ROOT/results/method-manifest-$arm.diff"
 CARGO_TARGET_DIR="$ROOT/method-target" cargo build --release --locked -p rspack_watcher --bin native-watcher-event-cost --target "$RUST_TARGET" > "$ROOT/results/method-build-$arm.log" 2>&1
 PLATFORM="$RUNNER_OS"
 DEST="$ROOT/bindings/optb-binding-$PLATFORM-$arm"
 if [[ "$RUNNER_OS" == Windows ]]; then cp "$ROOT/method-target/$RUST_TARGET/release/native-watcher-event-cost.exe" "$DEST/event-cost.exe"; else cp "$ROOT/method-target/$RUST_TARGET/release/native-watcher-event-cost" "$DEST/event-cost"; fi
 git checkout afc02802ce48e5ef83a0b5761d80139a1436f4e5 -- crates/rspack_watcher
 # The generated binary source is not tracked and is separate from the release binding.
done
node scripts/split-chunks-option-b-bench/run.cjs --prepare > "$ROOT/results/fixture.log" 2>&1
for scenario in offset0-edit files-only contexts-only missing-heavy method; do
 for rep in 1 2 3 4 5; do
  if (( rep % 2 )); then arms="restack final"; else arms="final restack"; fi
  for arm in $arms; do
   node --expose-gc scripts/split-chunks-option-b-bench/run.cjs "$arm" "$scenario" "$rep" > "$ROOT/results/$arm-$scenario-$rep.log" 2>&1
   printf 'SAMPLE %s %s %s PASS\n' "$arm" "$scenario" "$rep"
  done
 done
done
