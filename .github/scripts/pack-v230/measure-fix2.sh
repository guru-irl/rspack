#!/bin/bash
# Bytes the previous compilation holds in the rebuild snapshot of the watch scenario (385-module
# fixture, cold watch build plus one edit): v2.3.0 allocative build vs fix12 allocative build.
set -euo pipefail
W=$GITHUB_WORKSPACE/bench-data
S=$GITHUB_WORKSPACE/.github/scripts/pack-v230
export TMPDIR=$W/tmp
mkdir -p "$TMPDIR" "$W/results" "$W/measure"
M=$W/measure
cp "$S/gen.cjs" "$S/run.cjs" "$M/"
cd "$M"
printf '{"private":true}\n' > package.json
npm install --no-audit --no-fund --ignore-scripts "@rspack/core@$VERSION" > "$W/results/npm-install.log" 2>&1
node gen.cjs | tee "$W/results/fixture.txt"
echo "555f6678aa339ce4ebcadffd8cb2796f7149e721742852750e4b7ecee96a8a29  $W/base-allocative/rspack.linux-x64-gnu.node" | sha256sum -c

declare -A LIB=(
  [base-allocative]=$W/base-allocative/rspack.linux-x64-gnu.node
  [fix12-allocative]=$W/bindings/v230-fix12-allocative-binding/rspack.linux-x64-gnu.node
)
fail=0
: > "$W/results/summary.txt"
for a in base-allocative fix12-allocative; do
  printf '%s %s\n' "$a" "$(sha256sum "${LIB[$a]}" | cut -d' ' -f1)" | tee -a "$W/results/identities.txt"
  d=$W/results/alloc-$a; rm -rf "$d" "work/$a"; mkdir -p "$d" "work/$a"; cp -r template/src "work/$a/src"
  if ! env -u NAPI_RS_NATIVE_LIBRARY_PATH -u RSPACK_ALLOCATIVE_DIR EXPECT_SHA="$(sha256sum "${LIB[$a]}" | cut -d' ' -f1)" \
      NAPI_RS_NATIVE_LIBRARY_PATH="${LIB[$a]}" RSPACK_ALLOCATIVE_DIR="$d" node run.cjs "$a" watch > "$W/results/alloc-$a.log" 2>&1; then
    echo "$a watch run failed" | tee -a "$W/results/problems.txt"; fail=1; continue
  fi
  ls -l "$d" >> "$W/results/alloc-$a.log"
  f=$(find "$d" -name '*-rebuild.allocative' -size +0 | sort | head -1)
  [ -n "$f" ] || { echo "$a wrote no rebuild snapshot" | tee -a "$W/results/problems.txt"; fail=1; continue; }
  prev=$(awk '{ n = $NF; $NF = ""; if (index($0, "previous_compilation")) s += n } END { printf "%d", s }' "$f")
  assets=$(awk '{ n = $NF; $NF = ""; if (index($0, "previous_compilation") && $0 ~ /rspack_core::compilation::Compilation;assets[; ]/) s += n } END { printf "%d", s }' "$f")
  current=$(awk '{ n = $NF; $NF = ""; if ($0 ~ /^rspack_core::compiler::Compiler;compilation;rspack_core::compilation::Compilation;assets[; ]/) s += n } END { printf "%d", s }' "$f")
  all=$(awk '{ s += $NF } END { printf "%d", s }' "$f")
  printf '%s snapshot=%s previous_compilation_bytes=%s previous_assets_bytes=%s current_assets_bytes=%s snapshot_total_bytes=%s\n' \
    "$a" "${f##*/}" "$prev" "$assets" "$current" "$all" | tee -a "$W/results/summary.txt"
done
echo "measure fail=$fail" | tee -a "$W/results/summary.txt"
exit $fail
