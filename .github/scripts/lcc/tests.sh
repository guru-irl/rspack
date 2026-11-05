#!/usr/bin/env bash
# Runs the repository cases that use LimitChunkCountPlugin against each binding.
# Usage: tests.sh <results dir> <arm>=<.node path> ...
# The harness matches the -t value as a plain substring of each case path,
# so each call gets one value, and each call must pass at least one test.
set -uo pipefail
results=$1
shift
mkdir -p "$results"
config="Config.part1.test.mjs Config.part2.test.mjs Config.part3.test.mjs"
watch="Watch.part1.test.mjs Watch.part2.test.mjs Watch.part3.test.mjs Incremental-watch.test.mjs"
# <-t value>|<runner files>
calls=(
  "limit-chunk-count-plugin|$config StatsOutput.test.mjs $watch"
  "module-and-child-compilation|$config"
  "issue-13733|$config"
  "issue-12572|StatsOutput.test.mjs"
)
target="$PWD/crates/node_binding/rspack.linux-x64-gnu.node"
fails=0
for pair in "$@"; do
  arm=${pair%%=*}
  node_file=${pair#*=}
  # Copy over the workspace binding only. Don't set NAPI_RS_NATIVE_LIBRARY_PATH:
  # the test runner bundles with its own published @rspack/core, which honors it too.
  cp "$node_file" "$target"
  node -e '
    require("./crates/node_binding");
    const fs = require("fs");
    const line = fs.readFileSync("/proc/self/maps", "utf8").split("\n").find((l) => l.endsWith(".node") && l.includes("rspack"));
    const file = line.trim().split(/\s+/).pop();
    const sha = require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    console.log(`loaded ${file} ${sha}`);
  ' | tee "$results/$arm.loaded.txt"
  sha256sum "$node_file" | tee "$results/$arm.sha256"
  for call in "${calls[@]}"; do
    pattern=${call%%|*}
    read -r -a files <<< "${call#*|}"
    log="$results/$arm.$pattern.log"
    pnpm --dir tests/rspack-test run test "${files[@]}" -t "$pattern" > "$log" 2>&1
    rc=$?
    sed -i 's/\x1b\[[0-9;]*m//g' "$log"
    counts=$(grep -E '^\s*Tests\s' "$log" | tail -1 | tr -s ' ')
    passed=$(echo "$counts" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo 0)
    failed=$(echo "$counts" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo 0)
    stats=$(grep -c '^\[rspack-limit-chunk-count\]' "$log")
    shadow_false=$(grep '^\[rspack-limit-chunk-count\]' "$log" | grep -c '"shadow_equal":false')
    ok=yes
    if [ "$rc" -ne 0 ] || [ "$passed" -lt 1 ] || [ "$failed" -ne 0 ] || [ "$shadow_false" -ne 0 ]; then
      ok=no
      fails=$((fails + 1))
    fi
    printf '%s\t%s\texit=%s\tpassed=%s\tfailed=%s\tstats_lines=%s\tshadow_equal_false=%s\tok=%s\t%s\n' \
      "$arm" "$pattern" "$rc" "$passed" "$failed" "$stats" "$shadow_false" "$ok" "$counts" | tee -a "$results/outcome.tsv"
    grep -E '✓|✗|×' "$log" | grep -F -- "$pattern" | head -60 > "$results/$arm.$pattern.cases.txt"
    if [ "$ok" = no ]; then tail -60 "$log"; fi
  done
done
echo "failed calls: $fails" | tee -a "$results/outcome.tsv"
test "$fails" -eq 0
