#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD/.bench-pr66-merge-costs"
S=scripts/split-chunks-option-b-bench
mkdir -p "$ROOT/results" "$ROOT/tmp"
export TMPDIR="$ROOT/tmp"
pnpm install --frozen-lockfile > "$ROOT/results/runtime-install.log" 2>&1
test -f packages/rspack/compiled/watchpack/index.js
test -f packages/rspack/compiled/webpack-sources/index.js
node - "$ROOT" <<'JS'
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
assert.equal(process.platform,'win32');
const root=process.argv[2];
for(const arm of ['base','final']){
 const folder=path.join(root,'bindings',`optb-binding-Windows-${arm}`),core=path.join(folder,'core');
 fs.cpSync('packages/rspack/compiled',path.join(core,'compiled'),{recursive:true});
 fs.symlinkSync(path.resolve('packages/rspack/node_modules'),path.join(core,'node_modules'),'junction');
 const peer=path.join(folder,'node_modules/@rspack');fs.mkdirSync(peer,{recursive:true});
 fs.symlinkSync(path.resolve('crates/node_binding'),path.join(peer,'binding'),'junction');
}
JS
for script in prepare-windows-memory windows-memory-process windows-memory-workload windows-memory-driver summarize-windows-memory; do
 node --check "$S/$script.cjs"
done
node "$S/summarize-windows-memory.cjs" --self-test
node "$S/prepare-windows-memory.cjs" "$ROOT/resend" > "$ROOT/results/resend-fixture.log"
for rep in 1 2 3 4 5; do
 if ((rep%2)); then arms='base final'; else arms='final base'; fi
 for arm in $arms; do
  node --expose-gc "$S/windows-memory-driver.cjs" "$arm" "$rep" > "$ROOT/results/$arm-memory-$rep.log" 2>&1
 done
done
node "$S/summarize-windows-memory.cjs" "$ROOT/results"
