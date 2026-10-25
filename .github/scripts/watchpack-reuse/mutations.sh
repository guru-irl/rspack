set -euo pipefail
export NODE_OPTIONS="--require=$GITHUB_WORKSPACE/bench-data/scripts/identity.cjs"
source_file=packages/rspack/src/node/NodeWatchFileSystem.ts
cp "$source_file" bench-data/results/NodeWatchFileSystem.original.ts
restore() { cp bench-data/results/NodeWatchFileSystem.original.ts "$source_file"; }
trap restore EXIT
pnpm --dir tests/rspack-test run test --project base Compiler.test.mjs -t 'watchpack-reuse' --retry 0 2>&1 | tee bench-data/results/new-cases.log
cp rspack-test-event-report.txt bench-data/results/new-cases.events
for mutation in flush ownership listeners synchronous synthetic identity directory; do
  restore
  MUTATION="$mutation" python3 - <<'PY'
import os
from pathlib import Path
p = Path('packages/rspack/src/node/NodeWatchFileSystem.ts')
s = p.read_text()
mutation = os.environ['MUTATION']
def replace(old, new):
    global s
    assert s.count(old) == 1, (mutation, old, s.count(old))
    s = s.replace(old, new)
if mutation == 'flush':
    replace('if (reused) {', 'if (reused && Boolean(0)) {')
elif mutation == 'ownership':
    for field, value in [('aggregatedChanges', 'changes'), ('aggregatedRemovals', 'removals')]:
        replace(f'this.watcher.{field} = new Set();', f'this.watcher.{field} = {value};')
elif mutation == 'listeners':
    for event in ['change', 'remove', 'aggregated']:
        replace(f"watcher.removeAllListeners('{event}');", f"// Keep previous {event} listeners.")
elif mutation == 'synchronous':
    replace('process.nextTick(() => {', '((callback: () => void) => callback())(() => {')
elif mutation == 'synthetic':
    replace('safeTime >= startTime', 'safeTime >= 0')
elif mutation == 'identity':
    for field in ['files', 'directories', 'missing']:
        replace(f'{field} !== previous.{field} &&', '')
elif mutation == 'directory':
    replace('safeTime = directoryWatcher.lastWatchEvent;', "safeTime = (() => { const entry = directoryTimes.get(watchedPath); return entry && 'safeTime' in entry ? entry.safeTime : 0; })();")
else:
    raise AssertionError(mutation)
p.write_text(s)
PY
  pnpm --filter @rspack/core build > "bench-data/results/mutant-$mutation-build.log" 2>&1
  case "$mutation" in
    flush) filter=watchpack-reuse/held-build ;;
    ownership) filter=watchpack-reuse/manual-invalidate ;;
    listeners) filter=watchpack-reuse/same-options ;;
    synchronous) filter=watchpack-reuse/reentrant-invalidate ;;
    synthetic) filter=watchpack-reuse/synthetic-paused ;;
    identity) filter=watchpack-reuse/mutable-sets ;;
    directory) filter=watchpack-reuse/nested-directory ;;
  esac
  rc=0
  pnpm --dir tests/rspack-test run test --project base Compiler.test.mjs -t "$filter" --retry 0 2>&1 | tee "bench-data/results/mutant-$mutation.log" || rc=${PIPESTATUS[0]}
  cp rspack-test-event-report.txt "bench-data/results/mutant-$mutation.events"
  test "$rc" -ne 0
  MUTATION="$mutation" python3 - <<'PY'
import os
from pathlib import Path
s = Path('bench-data/results/mutant-' + os.environ['MUTATION'] + '.events').read_text()
assert 'TEST_RUN_END' in s
failed = [line for line in s.splitlines() if ' | TEST_END | ' in line and ' | fail | ' in line]
assert len(failed) == 1, failed
PY
done
restore
trap - EXIT
pnpm --filter @rspack/core build > bench-data/results/restored-build.log 2>&1
pnpm --dir tests/rspack-test run test --project base Compiler.test.mjs -t 'watchpack-reuse' --retry 0 2>&1 | tee bench-data/results/restored-cases.log
cp rspack-test-event-report.txt bench-data/results/restored-cases.events
