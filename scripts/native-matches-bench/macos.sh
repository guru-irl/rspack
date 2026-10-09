#!/bin/bash
set -euo pipefail
test "$(uname -m)" = arm64
ROOT=$PWD/.bench-native-matches-live-heap
mkdir -p "$ROOT/scripts" "$ROOT/artifacts/base" "$ROOT/artifacts/change" "$ROOT/tmp"
cp scripts/native-matches-bench/* "$ROOT/scripts/"
export TMPDIR=$ROOT/tmp
unset RAYON_NUM_THREADS TOKIO_WORKER_THREADS RSPACK_BINDING RSPACK_LIVE_HEAP_LOG
gh api repos/guru-irl/rspack/actions/artifacts/11612751820/zip > "$ROOT/counter-builds.zip"
python3 - "$ROOT" <<'EXTRACT'
import hashlib,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1]);z=zipfile.ZipFile(root/'counter-builds.zip')
for name in ['artifacts/base/binding.node','artifacts/base/commit.sha','artifacts/change/binding.node','artifacts/change/commit.sha','base-build.log','change-build.log']:
 p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(z.read(name))
expected={'base':'9b44a9f088f237fb9516a62b80d1b7ed26eb1196fee3db61664c195cf7ad9c29','change':'d120377564a09f0cf2e6a7bd7bdf53255c3a8a4d7706e9c54bc56beaf2bd1a53'}
for label,sha in expected.items():
 assert hashlib.sha256((root/'artifacts'/label/'binding.node').read_bytes()).hexdigest()==sha
 assert (root/'artifacts'/label/'commit.sha').read_text()==(root/'scripts'/f'{label}.sha').read_text()
print('REUSED MATCHED COUNTER BUILD IDENTITY PASS')
EXTRACT
BASE=$(< "$ROOT/scripts/base.sha")
git switch --detach "$BASE"
pnpm install --frozen-lockfile
pnpm run build:js > "$ROOT/base-js.log" 2>&1
mkdir -p "$ROOT/fixture"
cp "$ROOT/scripts/gen.mjs" "$ROOT/scripts/run.mjs" "$ROOT/fixture/"
node --check "$ROOT/fixture/run.mjs"
node "$ROOT/fixture/gen.mjs" --modules 60000
python3 "$ROOT/scripts/series.py" "$ROOT" "$PWD/packages/rspack"
# Retain synthetic records and identity evidence, not binary build artifacts.
rm -rf "$ROOT/fixture/src" "$ROOT/fixture/dist" "$ROOT/artifacts/base/binding.node" "$ROOT/artifacts/change/binding.node" "$ROOT/counter-builds.zip"
