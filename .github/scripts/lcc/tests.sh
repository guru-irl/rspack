#!/usr/bin/env bash
# Runs the repository cases that use LimitChunkCountPlugin against each binding.
# Usage: tests.sh <results dir> <arm>=<.node path> ...
set -uo pipefail
results=$1
shift
mkdir -p "$results"
pattern='limit-chunk-count|module-and-child-compilation|issue-13733|issue-12572'
files=(Config.part1.test.mjs Config.part2.test.mjs Config.part3.test.mjs StatsOutput.test.mjs
  Watch.part1.test.mjs Watch.part2.test.mjs Watch.part3.test.mjs Incremental-watch.test.mjs)
target="$PWD/crates/node_binding/rspack.linux-x64-gnu.node"
fails=0
for pair in "$@"; do
  arm=${pair%%=*}
  node_file=${pair#*=}
  cp "$node_file" "$target"
  export NAPI_RS_NATIVE_LIBRARY_PATH="$target"
  node -e '
    require("./crates/node_binding");
    const fs = require("fs");
    const line = fs.readFileSync("/proc/self/maps", "utf8").split("\n").find((l) => l.endsWith(".node") && l.includes("rspack"));
    const file = line.trim().split(/\s+/).pop();
    const sha = require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    console.log(`loaded ${file} ${sha}`);
  ' | tee "$results/$arm.loaded.txt"
  sha256sum "$node_file" | tee "$results/$arm.sha256"
  pnpm --dir tests/rspack-test run test "${files[@]}" -t "$pattern" > "$results/$arm.log" 2>&1
  rc=$?
  grep -E '^\s*(Test Files|Tests)\s' "$results/$arm.log" | tee "$results/$arm.counts.txt"
  grep -E '(✓|✗|×|FAIL|PASS).*(limit-chunk-count|module-and-child-compilation|issue-13733|issue-12572)' "$results/$arm.log" | head -40 > "$results/$arm.cases.txt"
  grep -c '^\[rspack-limit-chunk-count\]' "$results/$arm.log" | sed 's/^/stats lines: /' | tee "$results/$arm.statslines.txt"
  grep '^\[rspack-limit-chunk-count\]' "$results/$arm.log" | grep -c '"shadow_equal":false' | sed 's/^/shadow_equal false: /' | tee -a "$results/$arm.statslines.txt"
  echo "arm=$arm exit=$rc" | tee -a "$results/outcome.txt"
  if [ "$rc" -ne 0 ]; then fails=$((fails + 1)); tail -60 "$results/$arm.log"; fi
done
echo "failed arms: $fails" | tee -a "$results/outcome.txt"
test "$fails" -eq 0
