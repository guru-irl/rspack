#!/usr/bin/env bash
set -euo pipefail
PACK="$PWD/.spider/scratch/next-max-t/pack"
mkdir -p "$PACK"
pnpm --dir crates/node_binding run move-binding
pnpm --dir packages/rspack pack --pack-destination "$PACK"
pnpm --dir crates/node_binding pack --pack-destination "$PACK"
pnpm --dir npm/linux-x64-gnu pack --pack-destination "$PACK"
cp npm/linux-x64-gnu/rspack.linux-x64-gnu.node "$PACK/"
git rev-parse HEAD > "$PACK/commit.sha"
python3 - "$PACK" <<'PY'
from pathlib import Path
import sys
pack = Path(sys.argv[1])
text = Path('benchmarks/split-chunks-reuse/NEXT-MAX-T-README.md').read_text().replace('@COMMIT@', (pack / 'commit.sha').read_text().strip())
(pack / 'README.md').write_text(text)
PY
cd "$PACK"
sha256sum rspack-*.tgz rspack.linux-x64-gnu.node README.md commit.sha > SHA256SUMS
sha256sum -c SHA256SUMS
mkdir -p ../payload
for f in rspack-*.tgz; do
  mkdir -p "../payload/$f"
  tar -xzf "$f" -C "../payload/$f"
done
cmp rspack.linux-x64-gnu.node ../payload/rspack-binding-linux-x64-gnu-2.2.8.tgz/package/rspack.linux-x64-gnu.node
