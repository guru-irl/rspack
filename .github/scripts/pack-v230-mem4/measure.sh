#!/usr/bin/env bash
set -euo pipefail
W=${GITHUB_WORKSPACE:?}/bench-data
S=${GITHUB_WORKSPACE:?}/.github/scripts/pack-v230-mem4
PROFILE=${PROFILE:?}
PAIRS=${PAIRS:-8}
CONTROL=$W/control/rspack.linux-x64-gnu.node
CANDIDATE=$W/candidate/rspack.linux-x64-gnu.node
EXPECTED_CONTROL=${EXPECTED_CONTROL:-0485a440a7efe512ae78ad1e4235bfb2ece37c9d39f01fad2117ec6e0f364287}
mkdir -p "$W/tmp" "$W/results" "$W/fixture"
export TMPDIR=$W/tmp
M=$W/fixture
cp "$S/generate.cjs" "$S/generate-mixed.cjs" "$S/run.cjs" "$S/analyze.py" "$M/"
cd "$M"
printf '{"private":true}\n' > package.json
npm install --no-audit --no-fund --ignore-scripts "@rspack/core@2.3.0" > "$W/results/npm-install.log" 2>&1
python3 analyze.py --self-test | tee "$W/results/analyzer-control.txt"
if [ "$PROFILE" = mixed ]; then
  node generate-mixed.cjs template | tee "$W/results/fixture.txt"
else
  node generate.cjs "$PROFILE" | tee "$W/results/fixture.txt"
fi
mkdir -p work/same
cp -R template/src work/same/src
if [ -f template/package.json ]; then cp template/package.json work/same/; fi
printf '%s  %s\n' "$EXPECTED_CONTROL" "$CONTROL" | sha256sum -c
sha256sum "$CONTROL" "$CANDIDATE" | tee "$W/results/bindings.sha256"
if cmp -s "$CONTROL" "$CANDIDATE"; then
  test "${ALLOW_IDENTICAL:-0}" = 1 || { echo "bindings are unexpectedly identical" >&2; exit 1; }
else
  test "${ALLOW_IDENTICAL:-0}" = 0 || { echo "A/A bindings differ" >&2; exit 1; }
fi
{ date -u; uname -a; node --version; npm --version; lscpu; free -h; df -h .; } > "$W/results/environment.txt"

for i in $(seq 1 "$PAIRS"); do
  order=(control candidate)
  if (( i % 2 == 0 )); then order=(candidate control); fi
  for arm in "${order[@]}"; do
    library=$CONTROL
    if [ "$arm" = candidate ]; then library=$CANDIDATE; fi
    cp template/src/index.js work/same/src/index.js
    if [ "$PROFILE" = mixed ]; then
      cp template/src/modules/m0.js template/src/modules/m1.js work/same/src/modules/
    fi
    printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$i" "$arm" | tee -a "$W/results/order.txt"
    timeout --signal=TERM --kill-after=30s 600s \
      /usr/bin/time -o "$W/results/time-$arm-$i.json" \
      -f '{"peak_kib":%M,"wall_s":%e,"user_s":%U,"system_s":%S,"major_faults":%F,"involuntary_context_switches":%c}' \
      env -u NAPI_RS_NATIVE_LIBRARY_PATH -u RSPACK_ALLOCATIVE_DIR -u RSPACK_MEM_DIAG \
      PROFILE="$PROFILE" EXPECT_LIBRARY="$library" NAPI_RS_NATIVE_LIBRARY_PATH="$library" \
      node run.cjs "$W/results/metrics-$arm-$i.json" > "$W/results/run-$arm-$i.log" 2>&1
    test -s "$W/results/metrics-$arm-$i.json"
    test -s "$W/results/time-$arm-$i.json"
    (cd work/same/dist; find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$W/results/manifest-$arm-$i.txt"
    test -s "$W/results/manifest-$arm-$i.txt"
    if [ "$PROFILE" = mixed ]; then
      grep -qE '\.css$' "$W/results/manifest-$arm-$i.txt"
      test "$(grep -cE '\.js$' "$W/results/manifest-$arm-$i.txt")" -ge 2
    fi
  done
  cmp "$W/results/manifest-control-$i.txt" "$W/results/manifest-candidate-$i.txt"
  cmp "$W/results/manifest-control-1.txt" "$W/results/manifest-control-$i.txt"
done

cp "$W/results/manifest-control-1.txt" "$W/results/manifest-mutant-hash.txt"
python3 -c 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); s=p.read_text(); assert s; p.write_text(("0" if s[0] != "0" else "1") + s[1:])' "$W/results/manifest-mutant-hash.txt"
if cmp -s "$W/results/manifest-control-1.txt" "$W/results/manifest-mutant-hash.txt"; then echo "hash mismatch control failed" >&2; exit 1; fi
cp "$W/results/manifest-control-1.txt" "$W/results/manifest-mutant-path.txt"
printf '%s\n' 'extra-file' >> "$W/results/manifest-mutant-path.txt"
if cmp -s "$W/results/manifest-control-1.txt" "$W/results/manifest-mutant-path.txt"; then echo "path mismatch control failed" >&2; exit 1; fi
printf '%s\n' 'manifest controls passed: hash and path mismatches detected' | tee "$W/results/manifest-control.txt"
python3 analyze.py "$W/results" "$PAIRS" | tee "$W/results/summary.tsv"
