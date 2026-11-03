#!/bin/bash
# Output parity of official 2.3.0 and every fix arm on the 385-module fixture (cold, warm, watch,
# prod) and on a three-entry production build with shared split chunks (multi). Allocative arms
# must also write snapshots on request without changing output.
set -euo pipefail
W=$GITHUB_WORKSPACE/bench-data
S=$GITHUB_WORKSPACE/.github/scripts/pack-v230
export TMPDIR=$W/tmp
mkdir -p "$TMPDIR" "$W/results" "$W/fixture"
F=$W/fixture
cp "$S/gen.cjs" "$S/run.cjs" "$F/"
cd "$F"
printf '{"private":true}\n' > package.json
npm install --no-audit --no-fund --ignore-scripts "@rspack/core@$VERSION" > "$W/results/npm-install.log" 2>&1
OFF=$F/node_modules/@rspack/binding-linux-x64-gnu/rspack.linux-x64-gnu.node
(cd "$W/official" && sha256sum -c SHA256SUMS)
mkdir -p "$TMPDIR/official-gnu"
tar -xzf "$W/official/rspack-binding-linux-x64-gnu-$VERSION.tgz" -C "$TMPDIR/official-gnu"
cmp "$OFF" "$TMPDIR/official-gnu/package/rspack.linux-x64-gnu.node"
node gen.cjs | tee "$W/results/fixture.txt"

declare -A LIB
LIB[official]=$OFF
ARMS=(official)
for d in "$W"/bindings/v230-*-binding; do
  arm=${d##*/v230-}; arm=${arm%-binding}
  LIB[$arm]=$d/rspack.linux-x64-gnu.node
  ARMS+=("$arm")
done
echo "arms: ${ARMS[*]}" | tee "$W/results/arms.txt"
[ "${#ARMS[@]}" -ge 2 ]
SCENARIOS=(cold warm watch prod multi)

: > "$W/results/identities.txt"
for a in "${ARMS[@]}"; do
  f=${LIB[$a]}
  g=$(readelf --version-info "$f" | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -Vu | tail -1)
  printf '%s %s bytes=%s glibc=%s %s\n' "$a" "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "$g" "$f" | tee -a "$W/results/identities.txt"
done

# run_arm <arm> <name> [allocative base dir]: every scenario; returns non-zero on the first failure.
run_arm() {
  local arm=$1 name=$2 alloc=${3:-} lib=${LIB[$1]} exp sc
  exp=$(sha256sum "$lib" | cut -d' ' -f1)
  rm -rf "work/$name"; mkdir -p "work/$name"; cp -r template/src "work/$name/src"
  for sc in "${SCENARIOS[@]}"; do
    local envs=(EXPECT_SHA="$exp")
    if [ "$arm" != official ]; then envs+=(NAPI_RS_NATIVE_LIBRARY_PATH="$lib"); fi
    if [ -n "$alloc" ]; then mkdir -p "$alloc/$sc"; envs+=(RSPACK_ALLOCATIVE_DIR="$alloc/$sc"); fi
    env -u NAPI_RS_NATIVE_LIBRARY_PATH -u RSPACK_ALLOCATIVE_DIR "${envs[@]}" node run.cjs "$name" "$sc" || return 1
  done
}

fail=0
for a in "${ARMS[@]}"; do
  if ! run_arm "$a" "$a" >> "$W/results/parity.log" 2>&1; then echo "$a: parity run failed" | tee -a "$W/results/problems.txt"; fail=1; fi
done
: > "$W/results/parity.txt"
for a in "${ARMS[@]}"; do
  for sc in "${SCENARIOS[@]}"; do
    if cmp -s "results/official-$sc.txt" "results/$a-$sc.txt"; then echo "$sc: $a == official" >> "$W/results/parity.txt"; else echo "$sc: $a DIFFERS" | tee -a "$W/results/problems.txt"; fail=1; fi
  done
  if cmp -s "results/$a-cold.txt" "results/$a-warm.txt"; then echo "$a: warm == cold" >> "$W/results/parity.txt"; else echo "$a: warm DIFFERS from cold" | tee -a "$W/results/problems.txt"; fail=1; fi
done
if cmp -s results/official-cold.txt results/official-watch.txt; then echo "watch did not change output" | tee -a "$W/results/problems.txt"; fail=1; fi
for sc in "${SCENARIOS[@]}"; do
  printf '%s: %s files, %s maps\n' "$sc" "$(wc -l < "results/official-$sc.txt")" "$(grep -c '\.map$' "results/official-$sc.txt" || true)" >> "$W/results/parity.txt"
done
cat "$W/results/parity.txt"

# Allocative arms write one snapshot per build when asked (watch: two) and the output stays the same.
: > "$W/results/allocative.txt"
for a in "${ARMS[@]}"; do
  case $a in *allocative*) ;; *) continue ;; esac
  out=$W/results/allocative/$a
  rm -rf "$out"; mkdir -p "$out"
  for sc in "${SCENARIOS[@]}"; do cp "results/$a-$sc.txt" "results/$a.parity-$sc.txt"; done
  if ! run_arm "$a" "$a" "$out" > "$W/results/allocative-$a.log" 2>&1; then echo "$a: allocative run failed" | tee -a "$W/results/problems.txt"; fail=1; continue; fi
  for sc in "${SCENARIOS[@]}"; do
    n=$(find "$out/$sc" -name '*.allocative' -size +0 | wc -l)
    echo "$a $sc snapshots=$n" | tee -a "$W/results/allocative.txt"
    want=1; [ "$sc" = watch ] && want=2
    [ "$n" -ge "$want" ] || { echo "$a: missing snapshots in $sc" | tee -a "$W/results/problems.txt"; fail=1; }
    cmp -s "results/$a.parity-$sc.txt" "results/$a-$sc.txt" || { echo "$a: $sc output changed while collecting" | tee -a "$W/results/problems.txt"; fail=1; }
  done
  find "$out" -type f -printf '%s %p\n' | sort -k2 >> "$W/results/allocative.txt"
done
cp -r results "$W/results/manifests"
echo "verify fail=$fail" | tee -a "$W/results/parity.txt"
exit $fail
