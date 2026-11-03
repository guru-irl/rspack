#!/bin/bash
# Smoke for fix12r: the 385-module watch scenario (cold watch build plus one edit) with fix1 (run 41609779047),
# fix12 (run 41610719789, frees the previous assets at the swap) and fix12r (frees them after thisCompilation).
# Every arm runs from the same work path, 5 rounds in rotating order. Reports peak RSS, RSS right after the
# rebuild, and rebuild time (edit to second done, including the 50 ms aggregate timeout).
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
echo "b61e0726228ef54d431adb4c7179e3b2047f30151a1783c95f4e2b17dab3f31a  $W/fix1/rspack.linux-x64-gnu.node" | sha256sum -c
echo "7c4ecbc1dc7501bcbcb85ad7bf8f1b621c3e33294ad15bd61c1abcca67dad39a  $W/fix12/rspack.linux-x64-gnu.node" | sha256sum -c

declare -A LIB=(
  [fix1]=$W/fix1/rspack.linux-x64-gnu.node
  [fix12]=$W/fix12/rspack.linux-x64-gnu.node
  [fix12r]=$W/bindings/v230-fix12r-binding/rspack.linux-x64-gnu.node
)
ORDER=(fix1 fix12 fix12r)
: > "$W/results/runs.txt"
fail=0
for i in 1 2 3 4 5; do
  for k in 0 1 2; do
    a=${ORDER[$(( (k + i) % 3 ))]}
    rm -rf work/same; mkdir -p work/same; cp -r template/src work/same/src
    sha=$(sha256sum "${LIB[$a]}" | cut -d' ' -f1)
    if ! env -u NAPI_RS_NATIVE_LIBRARY_PATH EXPECT_SHA="$sha" NAPI_RS_NATIVE_LIBRARY_PATH="${LIB[$a]}" \
        /usr/bin/time -v -o "$W/results/time-$a-$i.txt" node run.cjs same watch > "$W/results/run-$a-$i.log" 2>&1; then
      echo "$a run $i failed" | tee -a "$W/results/problems.txt"; fail=1; continue
    fi
    grep -q "$sha" "$W/results/run-$a-$i.log"
    rb=$(grep -oE 'rebuild_ms=[0-9]+' "$W/results/run-$a-$i.log" | cut -d= -f2)
    after=$(grep -oE 'rss_after_rebuild_kib=[0-9]+' "$W/results/run-$a-$i.log" | cut -d= -f2)
    peak=$(awk -F': ' '/Maximum resident set size/ { print $2 }' "$W/results/time-$a-$i.txt")
    cp results/same-watch.txt "$W/results/manifest-$a-$i.txt"
    printf '%s %s peak_kib=%s after_rebuild_kib=%s rebuild_ms=%s\n' "$a" "$i" "$peak" "$after" "$rb" | tee -a "$W/results/runs.txt"
  done
done
for a in "${ORDER[@]}"; do
  awk -v a="$a" '$1 == a { split($3, p, "="); split($4, r, "="); split($5, t, "="); P[++n] = p[2] / 1024; R[n] = r[2] / 1024; T[n] = t[2] }
    function med(x, m,   i, j, s) { for (i = 1; i <= m; i++) s[i] = x[i]; for (i = 1; i <= m; i++) for (j = i + 1; j <= m; j++) if (s[j] < s[i]) { t0 = s[i]; s[i] = s[j]; s[j] = t0 }; return m % 2 ? s[(m + 1) / 2] : (s[m / 2] + s[m / 2 + 1]) / 2 }
    END { printf "%s: n=%d peak_median_mib=%.1f after_rebuild_median_mib=%.1f rebuild_median_ms=%.0f\n", a, n, med(P, n), med(R, n), med(T, n) }' "$W/results/runs.txt" | tee -a "$W/results/summary.txt"
done
for a in fix12 fix12r; do
  for i in 1 2 3 4 5; do
    [ -f "$W/results/manifest-$a-$i.txt" ] || continue
    cmp -s "$W/results/manifest-fix1-1.txt" "$W/results/manifest-$a-$i.txt" || { echo "$a run $i output differs from fix1" | tee -a "$W/results/problems.txt"; fail=1; }
  done
done
echo "measure fail=$fail" | tee -a "$W/results/summary.txt"
exit $fail
