set -euo pipefail
export NODE_OPTIONS="--require=$GITHUB_WORKSPACE/bench-data/scripts/identity.cjs"
run_suite() {
  local label="$1"
  shift
  local rc=0
  pnpm --dir tests/rspack-test run test "$@" 2>&1 | tee "bench-data/results/$label.log" || rc=${PIPESTATUS[0]}
  echo "$rc" > "bench-data/results/$label.exit"
  cp rspack-test-event-report.txt "bench-data/results/$label.events"
}
for repeat in 1 2; do
  for arm in normal forced; do
    if [[ "$arm" == forced ]]; then export RSPACK_WATCHPACK_REUSE=1; else unset RSPACK_WATCHPACK_REUSE; fi
    run_suite "watch-$arm-$repeat" --project base Watch.part1.test.mjs Watch.part2.test.mjs Watch.part3.test.mjs Incremental-watch.test.mjs
    run_suite "native-$arm-$repeat" --project nativeWatcher NativeWatcher.part1.test.mjs NativeWatcher.part2.test.mjs NativeWatcher.part3.test.mjs NativeWatcherIgnoredFunction.test.mjs
    run_suite "compiler-$arm-$repeat" --project base Compiler.test.mjs -t 'watch|invalidat|modif|remov|track'
    run_suite "multi-$arm-$repeat" --project base MultiCompiler.test.mjs -t 'watch|invalidate'
  done
done
unset RSPACK_WATCHPACK_REUSE
python3 bench-data/scripts/check-suites.py
