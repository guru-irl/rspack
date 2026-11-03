#!/bin/bash
# Synthetic memory A/B on the many-groups fixture. Peak RSS and wall time of official 2.3.0 and fix1,
# alternating the arm order over RUNS rounds, with output parity. Then RuntimeSpec bytes from one
# allocative snapshot each of the v2.3.0 allocative build and the fix1 allocative build.
set -euo pipefail
W=$GITHUB_WORKSPACE/bench-data
S=$GITHUB_WORKSPACE/.github/scripts/pack-v230
RUNS=${RUNS:-5}
export TMPDIR=$W/tmp
mkdir -p "$TMPDIR" "$W/results" "$W/measure"
M=$W/measure
cp "$S/gen-groups.cjs" "$S/run-groups.cjs" "$M/"
cd "$M"
command -v /usr/bin/time > /dev/null || { sudo apt-get update; sudo apt-get install -y time; }
printf '{"private":true}\n' > package.json
npm install --no-audit --no-fund --ignore-scripts "@rspack/core@$VERSION" > "$W/results/npm-install.log" 2>&1
node gen-groups.cjs | tee "$W/results/fixture.txt"
echo "555f6678aa339ce4ebcadffd8cb2796f7149e721742852750e4b7ecee96a8a29  $W/base-allocative/rspack.linux-x64-gnu.node" | sha256sum -c

declare -A LIB=(
  [official]=$M/node_modules/@rspack/binding-linux-x64-gnu/rspack.linux-x64-gnu.node
  [fix1]=$W/bindings/v230-fix1-binding/rspack.linux-x64-gnu.node
  [base-allocative]=$W/base-allocative/rspack.linux-x64-gnu.node
  [fix1-allocative]=$W/bindings/v230-fix1-allocative-binding/rspack.linux-x64-gnu.node
)
: > "$W/results/identities.txt"
for a in official fix1 base-allocative fix1-allocative; do
  printf '%s %s\n' "$a" "$(sha256sum "${LIB[$a]}" | cut -d' ' -f1)" | tee -a "$W/results/identities.txt"
done

# run <arm> <label> [allocative dir]: one build under /usr/bin/time.
run() {
  local arm=$1 label=$2 alloc=${3:-}
  local envs=(EXPECT_SHA="$(sha256sum "${LIB[$arm]}" | cut -d' ' -f1)")
  if [ "$arm" != official ]; then envs+=(NAPI_RS_NATIVE_LIBRARY_PATH="${LIB[$arm]}"); fi
  if [ -n "$alloc" ]; then envs+=(RSPACK_ALLOCATIVE_DIR="$alloc"); fi
  env -u NAPI_RS_NATIVE_LIBRARY_PATH -u RSPACK_ALLOCATIVE_DIR "${envs[@]}" \
    /usr/bin/time -o "$W/results/time-$label.txt" -f 'maxrss_kib=%M wall_s=%e' node run-groups.cjs "$arm"
}

fail=0
: > "$W/results/runs.txt"
for i in $(seq 1 "$RUNS"); do
  order=(official fix1); [ $((i % 2)) -eq 0 ] && order=(fix1 official)
  for a in "${order[@]}"; do
    if ! run "$a" "$a-$i" >> "$W/results/runs.log" 2>&1; then echo "$a run $i failed" | tee -a "$W/results/problems.txt"; fail=1; continue; fi
    printf '%s %s %s\n' "$a" "$i" "$(cat "$W/results/time-$a-$i.txt")" | tee -a "$W/results/runs.txt"
  done
done
cmp -s results/groups-official.txt results/groups-fix1.txt && echo "groups output: fix1 == official" | tee "$W/results/groups-parity.txt" \
  || { echo "groups output: fix1 DIFFERS" | tee -a "$W/results/problems.txt" "$W/results/groups-parity.txt"; fail=1; }
grep -E 'chunks=' "$W/results/runs.log" | head -2 >> "$W/results/groups-parity.txt" || true

node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
const by = {};
for (const l of lines) {
  const [arm] = l.split(" ");
  const rss = Number(/maxrss_kib=(\d+)/.exec(l)[1]) / 1024, wall = Number(/wall_s=([\d.]+)/.exec(l)[1]);
  (by[arm] ||= { rss: [], wall: [] }); by[arm].rss.push(rss); by[arm].wall.push(wall);
}
const med = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
for (const [arm, v] of Object.entries(by)) console.log(`${arm}: n=${v.rss.length} peak_rss_median_mib=${med(v.rss).toFixed(1)} wall_median_s=${med(v.wall).toFixed(2)} rss=[${v.rss.map(x => x.toFixed(0)).join(",")}] wall=[${v.wall.join(",")}]`);
' "$W/results/runs.txt" | tee "$W/results/summary.txt"

# RuntimeSpec bytes in one allocative snapshot per build (exclusive weights, so sums are inclusive).
for a in base-allocative fix1-allocative; do
  d=$W/results/alloc-$a; rm -rf "$d"; mkdir -p "$d"
  if ! run "$a" "$a" "$d" > "$W/results/alloc-$a.log" 2>&1; then echo "$a allocative run failed" | tee -a "$W/results/problems.txt"; fail=1; continue; fi
  f=$(find "$d" -name '*.allocative' -size +0 | sort | head -1)
  [ -n "$f" ] || { echo "$a wrote no snapshot" | tee -a "$W/results/problems.txt"; fail=1; continue; }
  total=$(awk '{ n = $NF; $NF = ""; if (index($0, "rspack_core::runtime::RuntimeSpec")) s += n } END { printf "%d", s }' "$f")
  unused=$(awk '{ n = $NF; $NF = ""; if (index($0, "rspack_core::runtime::RuntimeSpec;inner;") && $0 ~ /;unused_capacity $/) s += n } END { printf "%d", s }' "$f")
  all=$(awk '{ s += $NF } END { printf "%d", s }' "$f")
  printf '%s snapshot=%s runtime_spec_bytes=%s runtime_spec_unused_capacity_bytes=%s snapshot_total_bytes=%s\n' "$a" "${f##*/}" "$total" "$unused" "$all" | tee -a "$W/results/summary.txt"
done
echo "measure fail=$fail" | tee -a "$W/results/summary.txt"
exit $fail
