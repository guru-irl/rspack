#!/usr/bin/env bash
set -euo pipefail
W="$GITHUB_WORKSPACE/bench-data"
S="$GITHUB_WORKSPACE/.github/scripts/pack-v230"
M="$W/measure-mem4"
R="$W/results/memory"
export TMPDIR="$W/tmp"
mkdir -p "$M" "$R" "$TMPDIR"
cp "$S/gen-mem4.cjs" "$S/run-mem4.cjs" "$S/analyze-mem4.py" "$S/validate-mem4.py" "$M/"
cd "$M"
printf '{"private":true}\n' > package.json
npm install --no-audit --no-fund --ignore-scripts "@rspack/core@$VERSION" > "$R/npm-install.log" 2>&1
MODULES=30000 node gen-mem4.cjs "$M/fixture" | tee "$R/fixture.json"

declare -A LIB=(
  [fix12r]="$W/fix12r/rspack.linux-x64-gnu.node"
  [m1]="$W/bindings/v230-m1-binding/rspack.linux-x64-gnu.node"
  [aa]="$W/bindings/v230-m1-binding/rspack.linux-x64-gnu.node"
)
echo "0485a440a7efe512ae78ad1e4235bfb2ece37c9d39f01fad2117ec6e0f364287  ${LIB[fix12r]}" | sha256sum -c
for arm in "${!LIB[@]}"; do
  test -s "${LIB[$arm]}"
  printf '%s %s\n' "$arm" "$(sha256sum "${LIB[$arm]}")" | tee -a "$R/bindings.txt"
done

reset_fixture() {
  printf 'export const v0 = 0;\n' > fixture/src/modules/m0.js
  printf 'export const v1 = 1;\n' > fixture/src/modules/m1.js
}
run_one() {
  local arm=$1 log=$2 peak=$3 sha
  reset_fixture
  sha=$(sha256sum "${LIB[$arm]}" | cut -d' ' -f1)
  env -u RSPACK_MEM_DIAG EXPECT_SHA="$sha" NAPI_RS_NATIVE_LIBRARY_PATH="${LIB[$arm]}" \
    /usr/bin/time -f '%M' -o "$peak" node run-mem4.cjs "$M/fixture" > "$log" 2> "$log.stderr"
}

# Count modules in a separate run so JS wrapper creation cannot inflate measured RSS.
reset_fixture
sha=$(sha256sum "${LIB[fix12r]}" | cut -d' ' -f1)
env -u RSPACK_MEM_DIAG COUNT_MODULES=1 EXPECT_SHA="$sha" NAPI_RS_NATIVE_LIBRARY_PATH="${LIB[fix12r]}" \
  node run-mem4.cjs "$M/fixture" > "$R/count.jsonl" 2> "$R/count.stderr"
python3 -c 'import json,sys; p=[json.loads(s) for s in open(sys.argv[1]) if s.startswith("{")]; assert len(p)==3 and p[-1]["modules"]>=30000; json.dump({"modules":p[-1]["modules"]},open(sys.argv[2],"w"))' "$R/count.jsonl" "$R/fixture-count.json"

compare() {
  local a=$1 b=$2 i first second dir="$R/$1-vs-$2"
  mkdir -p "$dir"
  cp "$R/fixture-count.json" "$dir/"
  for i in 1 2 3 4 5; do
    if (( i % 2 )); then first=$a; second=$b; else first=$b; second=$a; fi
    for arm in "$first" "$second"; do
      echo "pair=$i arm=$arm $(date -u +%FT%TZ)" | tee -a "$dir/order.txt"
      run_one "$arm" "$dir/$arm-$i.jsonl" "$dir/$arm-$i.peak-kib"
    done
  done
  python3 analyze-mem4.py "$dir" "$a" "$b" 5 | tee "$dir/summary.csv"
}
compare fix12r m1
compare m1 aa

for arm in m1; do
  reset_fixture
  file="$R/diag-$arm.jsonl"
  sha=$(sha256sum "${LIB[$arm]}" | cut -d' ' -f1)
  env RSPACK_MEM_DIAG="$file" EXPECT_SHA="$sha" NAPI_RS_NATIVE_LIBRARY_PATH="${LIB[$arm]}" \
    node run-mem4.cjs "$M/fixture" > "$R/diag-$arm-run.jsonl" 2> "$R/diag-$arm.stderr"
  python3 validate-mem4.py "$file"
  test ! -s "$R/diag-$arm.stderr"
  python3 -c 'import json,sys; a=[json.loads(s) for s in open(sys.argv[1]) if s.startswith("{")]; b=[json.loads(s) for s in open(sys.argv[2]) if s.startswith("{")]; assert len(a)==len(b)==3 and all(x["outputs"]==y["outputs"] for x,y in zip(a,b)); print("diagnostic-on output parity passed")' "$R/diag-$arm-run.jsonl" "$R/fix12r-vs-m1/m1-1.jsonl"
done
