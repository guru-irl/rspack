#!/bin/bash
set -euo pipefail
ARM=${1:?} KIND=${2:?}
mkdir -p .diag/results .diag/fixtures .diag/tmp
export ADV_BASE="$PWD/.diag/fixtures" TMPDIR="$PWD/.diag/tmp" NSLIMIT=30
export NAPI_RS_NATIVE_LIBRARY_PATH="$(realpath source/crates/node_binding/*.node)"
H=$(sha256sum "$NAPI_RS_NATIVE_LIBRARY_PATH" | awk '{print $1}')
printf '%s %s %s\n' "$ARM" "$KIND" "$H" | tee ".diag/results/binding-$KIND.txt"
timeout 240 sh bench/c4b/nslimit.sh strace -f -ttt -s 512 -e trace=inotify_init1,inotify_add_watch,inotify_rm_watch,close,write -o ".diag/results/native-$KIND.strace" node bench/rework-16539/s03b-state.cjs "$PWD/source" "$ARM-$KIND" native "$H" limitretain > ".diag/results/$KIND.jsonl" 2> ".diag/results/$KIND.stderr"
