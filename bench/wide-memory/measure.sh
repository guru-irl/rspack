#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD/.bench-wide"
mkdir -p "$ROOT/results" "$ROOT/tmp"
export TMPDIR="$ROOT/tmp"
if [[ "$RUNNER_OS" == Windows ]]; then
 export TMPDIR="$(cygpath -w "$ROOT/tmp")" TEMP="$(cygpath -w "$ROOT/tmp")" TMP="$(cygpath -w "$ROOT/tmp")"
fi
unset RSPACK_BINDING NAPI_RS_NATIVE_LIBRARY_PATH RAYON_NUM_THREADS TOKIO_WORKER_THREADS
pnpm --dir source install --frozen-lockfile > "$ROOT/results/runtime-install.log" 2>&1
node - "$ROOT" <<'JS'
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=process.argv[2],platform={linux:'Linux',darwin:'macOS',win32:'Windows'}[process.platform];
for(const arm of ['main','before','fix']) {
 const folder=path.join(root,'bindings',`wide-binding-${platform}-${arm}`),core=path.join(folder,'core');
 fs.cpSync('source/packages/rspack/compiled',path.join(core,'compiled'),{recursive:true});
 fs.symlinkSync(path.resolve('source/packages/rspack/node_modules'),path.join(core,'node_modules'),process.platform==='win32'?'junction':'dir');
 const peer=path.join(folder,'node_modules/@rspack');fs.mkdirSync(peer,{recursive:true});
 fs.symlinkSync(path.resolve('source/crates/node_binding'),path.join(peer,'binding'),process.platform==='win32'?'junction':'dir');
 fs.copyFileSync(path.join(folder,'identity.json'),path.join(root,'results',`identity-${arm}.json`));
}
fs.writeFileSync(path.join(root,'results','host.json'),JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,cpus:os.cpus(),totalMemory:os.totalmem(),runner:process.env.RUNNER_NAME,release:os.release()},null,2));
JS
for file in bench/wide-memory/*.cjs; do node --check "$file"; done
node bench/wide-memory/prepare.cjs > "$ROOT/results/fixtures.jsonl"
if [[ "$RUNNER_OS" == Windows ]]; then
 FIXTURE="$(node -p 'require("node:fs").realpathSync.native(".bench-wide/fixtures/wide")')"
 powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/wide-memory/observe.ps1 -SelfControl -Fixture "$FIXTURE" > "$ROOT/results/directory-control.json"
fi
if [[ "${BENCH_OBSERVER_RED:-0}" == 1 || "${BENCH_METADATA_RED:-0}" == 1 ]]; then
 MODE=observer-negative; MARKER=OBSERVER_IN_PROBE_GAP
 if [[ "${BENCH_METADATA_RED:-0}" == 1 ]]; then MODE=retained-stats-negative; MARKER=INITIAL_METADATA_RETAINED_OBJECT; fi
 if node bench/wide-memory/sample.cjs main modules 1 "$MODE" > "$ROOT/results/$MODE.log" 2>&1; then
  echo NEGATIVE_CONTROL_ACCEPTED; exit 97
 fi
 grep -q "$MARKER" "$ROOT/results/$MODE.log"
 echo NEGATIVE_CONTROL_REJECTED
 exit 0
fi
node bench/wide-memory/measure.cjs
