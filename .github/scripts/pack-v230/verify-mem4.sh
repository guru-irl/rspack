#!/usr/bin/env bash
set -euo pipefail
W="$GITHUB_WORKSPACE/bench-data"
S="$GITHUB_WORKSPACE/.github/scripts/pack-v230"
F="$W/parity-fixture"
export TMPDIR="$W/tmp"
mkdir -p "$TMPDIR" "$W/results" "$F" "$W/results/manifests"
cp "$S/gen.cjs" "$S/run.cjs" "$F/"
cd "$F"
printf '{"private":true}\n' > package.json
npm install --no-audit --no-fund --ignore-scripts "@rspack/core@$VERSION" > "$W/results/parity-install.log" 2>&1
(cd "$W/official" && sha256sum -c SHA256SUMS)
mkdir -p "$TMPDIR/official-gnu"
tar -xzf "$W/official/rspack-binding-linux-x64-gnu-$VERSION.tgz" -C "$TMPDIR/official-gnu"
OFF="$F/node_modules/@rspack/binding-linux-x64-gnu/rspack.linux-x64-gnu.node"
cmp "$OFF" "$TMPDIR/official-gnu/package/rspack.linux-x64-gnu.node"
M2="$W/pack/rspack.linux-x64-gnu.node"
CORE="$W/pack/rspack-core-2.3.0.tgz"
node gen.cjs | tee "$W/results/parity-fixture.txt"
SCENARIOS=(cold warm watch prod multi child)
run_arm() {
  local arm=$1 lib=$2 sha sc
  sha=$(sha256sum "$lib" | cut -d' ' -f1)
  rm -rf work/same
  mkdir -p work/same
  cp -r template/src work/same/src
  for sc in "${SCENARIOS[@]}"; do
    local envs=(EXPECT_SHA="$sha")
    if [ "$arm" != official ]; then envs+=(NAPI_RS_NATIVE_LIBRARY_PATH="$lib"); fi
    if [ "$arm" = on ]; then envs+=(RSPACK_EMITTED_SOURCES=size-only); fi
    env -u NAPI_RS_NATIVE_LIBRARY_PATH -u RSPACK_ALLOCATIVE_DIR -u RSPACK_EMITTED_SOURCES "${envs[@]}" \
      node run.cjs same "$sc" >> "$W/results/parity.log" 2>&1
    test -s "results/same-$sc.txt"
    if [ "$sc" = child ]; then test -s "dist/same/child/child.js"; fi
    mv "results/same-$sc.txt" "results/$arm-$sc.txt"
  done
}
run_arm official "$OFF"
npm install --no-audit --no-fund --ignore-scripts --no-save "$CORE" >> "$W/results/parity-install.log" 2>&1
node -e 'const p=require("@rspack/core/package.json"); if(p.version!=="2.3.0") throw Error("wrong core version")'
mkdir -p "$TMPDIR/packed-core"
tar -xzf "$CORE" -C "$TMPDIR/packed-core"
cmp "$TMPDIR/packed-core/package/dist/index.js" "$F/node_modules/@rspack/core/dist/index.js"
run_arm off "$M2"
run_arm on "$M2"
# Check that the comparator catches both altered content and altered filenames.
if cmp -s <(printf 'a  file\n') <(printf 'b  file\n'); then exit 1; fi
if cmp -s <(printf 'a  file\n') <(printf 'a  other\n'); then exit 1; fi
: > "$W/results/parity.txt"
for arm in off on; do
  for sc in "${SCENARIOS[@]}"; do
    cmp "results/official-$sc.txt" "results/$arm-$sc.txt"
    printf '%s: %s == official (%s files)\n' "$sc" "$arm" "$(wc -l < "results/$arm-$sc.txt")" | tee -a "$W/results/parity.txt"
  done
done
for arm in official off on; do
  cmp "results/$arm-cold.txt" "results/$arm-warm.txt"
done
if cmp -s results/official-cold.txt results/official-watch.txt; then
  echo 'watch edit did not change output' >&2
  exit 1
fi
cp results/*.txt "$W/results/manifests/"
printf 'official=%s\nm2=%s\ncore=%s\n' "$(sha256sum "$OFF")" "$(sha256sum "$M2")" "$(sha256sum "$CORE")" > "$W/results/parity-identities.txt"
