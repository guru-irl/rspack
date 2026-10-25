set -euo pipefail
export NODE_OPTIONS="--require=$GITHUB_WORKSPACE/bench-data/scripts/identity.cjs"
source_file=packages/rspack/src/node/NodeWatchFileSystem.ts
cp "$source_file" bench-data/results/NodeWatchFileSystem.original.ts
restore() { cp bench-data/results/NodeWatchFileSystem.original.ts "$source_file"; }
trap restore EXIT
pnpm --dir tests/rspack-test run test --project base Compiler.test.mjs -t 'watchpack-reuse' --retry 0 2>&1 | tee bench-data/results/new-cases.log
cp rspack-test-event-report.txt bench-data/results/new-cases.events
for mutation in flush ownership; do
  restore
  MUTATION="$mutation" python3 - <<'PY'
import os
from pathlib import Path
p = Path('packages/rspack/src/node/NodeWatchFileSystem.ts')
s = p.read_text()
old = 'if (reused) {' if os.environ['MUTATION'] == 'flush' else 'if (this.#reuse && this.watcher?.paused) {'
# The reuse branch uses a different condition than the flush branch.
assert s.count(old) == 1, (old, s.count(old))
p.write_text(s.replace(old, 'if (false) {'))
PY
  pnpm --filter @rspack/core build > "bench-data/results/mutant-$mutation-build.log" 2>&1
  if [[ "$mutation" == flush ]]; then filter='should flush an edit made during a held rebuild exactly once'; else filter='should consume paused changes on manual invalidate without replay'; fi
  rc=0
  pnpm --dir tests/rspack-test run test --project base Compiler.test.mjs -t "$filter" --retry 0 2>&1 | tee "bench-data/results/mutant-$mutation.log" || rc=${PIPESTATUS[0]}
  cp rspack-test-event-report.txt "bench-data/results/mutant-$mutation.events"
  test "$rc" -ne 0
  MUTATION="$mutation" python3 - <<'PY'
import os
from pathlib import Path
s = Path('bench-data/results/mutant-' + os.environ['MUTATION'] + '.events').read_text()
assert 'TEST_RUN_END' in s
assert any(' | TEST_END | ' in line and ' | fail | ' in line for line in s.splitlines())
PY
done
restore
trap - EXIT
pnpm --filter @rspack/core build > bench-data/results/restored-build.log 2>&1
pnpm --dir tests/rspack-test run test --project base Compiler.test.mjs -t 'watchpack-reuse' --retry 0 2>&1 | tee bench-data/results/restored-cases.log
cp rspack-test-event-report.txt bench-data/results/restored-cases.events
