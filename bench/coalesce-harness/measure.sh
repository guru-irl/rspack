#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD/.bench-coalesce"
S=bench/coalesce-harness
mkdir -p "$ROOT/results" "$ROOT/tmp" "$ROOT/fixtures"
export TMPDIR="$ROOT/tmp"
if [[ "$RUNNER_OS" == Windows ]]; then
 export TMPDIR="$(cygpath -w "$ROOT/tmp")"
 export TEMP="$TMPDIR" TMP="$TMPDIR"
fi
unset RSPACK_BINDING NAPI_RS_NATIVE_LIBRARY_PATH RAYON_NUM_THREADS TOKIO_WORKER_THREADS
node "$S/identity-check.cjs" "$ROOT/tmp" > "$ROOT/results/identity-control.log" 2>&1
pnpm --dir source install --frozen-lockfile > "$ROOT/results/runtime-install.log" 2>&1
node - "$ROOT" <<'JS'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.argv[2], platform = {linux: 'Linux', darwin: 'macOS', win32: 'Windows'}[process.platform];
let coreHash;
for (const arm of ['main', 'pr', 'new']) {
 const folder = path.join(root, 'bindings', `coalesce-binding-${platform}-${arm}`), core = path.join(folder, 'core');
 const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'identity.json'), 'utf8'));
 assert.deepEqual(manifest.features, ['plugin', 'info-level']);
 if (coreHash) assert.equal(manifest.coreIndexHash, coreHash, 'JavaScript differs between arms');
 coreHash = manifest.coreIndexHash;
 fs.cpSync('source/packages/rspack/compiled', path.join(core, 'compiled'), {recursive: true});
 fs.symlinkSync(path.resolve('source/packages/rspack/node_modules'), path.join(core, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
 const peer = path.join(folder, 'node_modules/@rspack');
 fs.mkdirSync(peer, {recursive: true});
 fs.symlinkSync(path.resolve('source/crates/node_binding'), path.join(peer, 'binding'), process.platform === 'win32' ? 'junction' : 'dir');
 fs.copyFileSync(path.join(folder, 'identity.json'), path.join(root, 'results', `identity-${arm}.json`));
}
fs.writeFileSync(path.join(root, 'results', 'host.json'), JSON.stringify({platform: process.platform, arch: process.arch, node: process.version, cpus: require('node:os').cpus().length, runner: process.env.RUNNER_NAME}, null, 2));
JS
for scenario in single multi; do
 for rep in 1 2 3 4 5; do
  if ((rep%2)); then arms='main pr new'; else arms='new pr main'; fi
  for arm in $arms; do
   test "$(date -u +%s)" -lt 1793293200
   node "$S/burst.mjs" "$arm" "$scenario" "$rep" > "$ROOT/results/$scenario-$arm-$rep.log" 2>&1
  done
 done
done
node "$S/summarize.cjs" "$ROOT/results" --self-test
