#!/usr/bin/env bash
set -euo pipefail
root="$GITHUB_WORKSPACE"
scratch="$root/.spider/scratch/drop-prev-compilation"
tools="$scratch/tools"
results="$scratch/results"
mkdir -p "$scratch/binaries"
# Both versions use the exact same source packages, toolchain and CI profile.
# Checksum freshness avoids accidentally reusing same-version crate artifacts.
for variant in baseline prototype; do
  ref=f2903b6482cb7a0fcdca912d23062bd94d3d5636
  if [ "$variant" = prototype ]; then ref="$PROTOTYPE"; fi
  git checkout --detach "$ref"
  git rev-parse HEAD > "$results/$variant-head.txt"
  pnpm install --frozen-lockfile
  cargo codegen
  printf '\nchecksum-freshness = true\n' >> .cargo/config.toml
  if [ "$PHASE" = diagnostic ]; then python "$tools/instrument.py" "$root"; fi
  MEASURE_CARGO_FRESH=1 pnpm build:binding:ci > "$results/$variant-build.log" 2>&1
  binary=$(find crates/node_binding -maxdepth 1 -name 'rspack.*.node' -print -quit)
  test -n "$binary"
  cp "$binary" "$scratch/binaries/$variant.node"
  # Restore generated files before switching commits, not user source.
  git restore --worktree .cargo/config.toml crates/node_binding/napi-binding.d.ts
  if [ "$PHASE" = diagnostic ]; then
    git restore --worktree crates/rspack_allocator/src/lib.rs crates/rspack_binding_api/src/lib.rs crates/rspack_core/src/artifacts/incremental_artifacts.rs crates/rspack_core/Cargo.toml Cargo.lock
  fi
done
pnpm --filter @rspack/core build > "$results/js-build.log" 2>&1
cp "$tools/fixture.mjs" packages/rspack/drop-prev-fixture.mjs
binary=$(find crates/node_binding -maxdepth 1 -name 'rspack.*.node' -print -quit)
pairs=5
if [ "$PHASE" = diagnostic ]; then pairs=1; fi
for ((pair=1; pair<=pairs; pair++)); do
  variants='baseline prototype'
  if ((pair % 2 == 0)); then variants='prototype baseline'; fi
  for variant in $variants; do
    cp "$scratch/binaries/$variant.node" "$binary"
    run="$scratch/run-$pair-$variant"
    export FIXTURE_ROOT="$run" SAMPLES=20 FULL_STATS=1
    export NAPI_RS_NATIVE_LIBRARY_PATH="$scratch/binaries/$variant.node"
    if [ "$PHASE" = diagnostic ]; then export SAMPLES=35; fi
    node --expose-gc packages/rspack/drop-prev-fixture.mjs > "$results/$pair-$variant-stdout.log" 2> "$results/$pair-$variant-stderr.log"
    cp -R "$run/results" "$results/$pair-$variant"
    rm -rf "$run"
  done
done
python "$tools/summarize.py" "$results" > "$results/summary.json"
