#!/usr/bin/env bash
set -euo pipefail
ROOT=$PWD/.bench-stable-absence
ART=$ROOT/artifact
SOURCE=crates/rspack_core/src/artifacts/build_chunk_graph_artifact.rs
BINDING=crates/node_binding/rspack.linux-x64-gnu.node
cp "$SOURCE" "$ROOT/guard-source.saved"
restore() {
  cp "$ROOT/guard-source.saved" "$SOURCE"
  cp "$ART/binding.node" "$BINDING"
}
trap restore EXIT
python - "$SOURCE" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
a='''  !compilation.options.optimization.side_effects.is_true()
    && !compilation.options.optimization.used_exports.is_enable()'''
assert s.count(a)==1
p.write_text(s.replace(a,'  !compilation.options.optimization.used_exports.is_enable()'))
PY
pnpm run build:binding:release > "$ART/mutant-build.log" 2>&1
grep -F 'Compiling rspack_core' "$ART/mutant-build.log"
sha256sum "$BINDING" > "$ART/mutant-native.sha256"
unset RSPACK_BINDING NAPI_RS_NATIVE_LIBRARY_PATH
rc=0
CI=true pnpm --dir tests/rspack-test run test --project base Watch.part1.test.mjs -t code-splitting-cache/stable-absence-side-effects --retry 0 > "$ART/mutant.log" 2>&1 || rc=$?
printf '%s\n' "$rc" > "$ART/mutant.exit"
cp rspack-test-event-report.txt "$ART/mutant.events"
restore
CI=true pnpm --dir tests/rspack-test run test --project base Watch.part1.test.mjs -t code-splitting-cache/stable-absence-side-effects --retry 0 > "$ART/restored-guard.log" 2>&1
cp rspack-test-event-report.txt "$ART/restored-guard.events"
python - "$ART" "$BINDING" <<'PY'
from pathlib import Path
import hashlib,json,sys
p=Path(sys.argv[1]);s=(p/'mutant.log').read_text();e=(p/'mutant.events').read_text()
assert int((p/'mutant.exit').read_text()) != 0
assert 'TEST_RUN_END' in e
failed=[l for l in e.splitlines() if ' | TEST_END | ' in l and ' | fail | ' in l]
assert len(failed)==1 and 'stable-absence-side-effects' in failed[0] and 'step 1' in failed[0],failed
assert "Cannot find module './x'" in s,s[-4000:]
r=(p/'restored-guard.events').read_text()
assert 'TEST_RUN_END' in r and ' | fail | ' not in r
assert len([l for l in r.splitlines() if ' | TEST_END | ' in l and ' | pass | ' in l])==2
assert hashlib.sha256(Path(sys.argv[2]).read_bytes()).digest()==hashlib.sha256((p/'binding.node').read_bytes()).digest()
(p/'guard-control.json').write_text(json.dumps({'mutantFailure':failed,'restoredPasses':2,'bindingRestored':True},indent=2)+'\n')
print((p/'guard-control.json').read_text())
PY
