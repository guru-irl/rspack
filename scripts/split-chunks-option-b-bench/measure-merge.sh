#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD/.bench-pr66-merge-costs"
S=scripts/split-chunks-option-b-bench
mkdir -p "$ROOT/results" "$ROOT/tmp"
export TMPDIR="$ROOT/tmp"
# Runtime dependencies only: use the already-built core JS and native artifacts.
pnpm install --frozen-lockfile > "$ROOT/results/runtime-install.log" 2>&1
test -f packages/rspack/compiled/watchpack/index.js
test -f packages/rspack/compiled/webpack-sources/index.js
node - "$ROOT" <<'JS'
const fs=require('node:fs'),path=require('node:path');const root=process.argv[2],platform={linux:'Linux',darwin:'macOS',win32:'Windows'}[process.platform];
for(const arm of ['base','final']){const folder=path.join(root,'bindings',`optb-binding-${platform}-${arm}`),core=path.join(folder,'core');fs.cpSync('packages/rspack/compiled',path.join(core,'compiled'),{recursive:true});fs.symlinkSync(path.resolve('packages/rspack/node_modules'),path.join(core,'node_modules'),process.platform==='win32'?'junction':'dir');const peer=path.join(folder,'node_modules/@rspack');fs.mkdirSync(peer,{recursive:true});fs.symlinkSync(path.resolve('crates/node_binding'),path.join(peer,'binding'),process.platform==='win32'?'junction':'dir');}
JS
node "$S/prepare-resend.cjs" "$ROOT/resend" > "$ROOT/results/resend-fixture.log"
node "$S/prepare-followup.cjs" "$ROOT/missing-followup" > "$ROOT/results/followup-fixture.log"
for scenario in resend missing-followup; do
 for rep in 1 2 3 4 5; do
  if ((rep%2)); then arms='base final'; else arms='final base'; fi
  for arm in $arms; do
   test "$(date -u +%s)" -lt 1793148900
   node --expose-gc "$S/measurement.cjs" "$arm" "$scenario" "$rep" > "$ROOT/results/$arm-$scenario-$rep.log" 2>&1
  done
 done
done
