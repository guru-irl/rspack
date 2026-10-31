#!/bin/bash
# usage: arm.sh <fix|head|main|wp> <driver> <tag> <real|link> <sessions|->
# Runs one driver against one arm with the binding pinned and its SHA-256 checked.
set -uo pipefail
W=$GITHUB_WORKSPACE
ARM=$1 DRIVER=$2 TAG=$3 ROOT=$4 ONLY=${5:--}
[ "$ONLY" != - ] || ONLY=''
T=$ARM; MODE=native
if [ "$ARM" = wp ]; then T=head; MODE=watchpack; fi
TREE=$W/t-$T
N=$(realpath "$(ls "$TREE"/crates/node_binding/*.node)")
H=$(sha256sum "$N" | cut -d' ' -f1)
case $T in
  fix) E=edefdc6165765f4cdb3b085c92dc52031aff5985203d8baa6dd1302cf55fb7ea;;
  head) E=3eae0694f57777d107e1b64fcb0bec14b672c42d6b0c611fa22a06f43e2dac96;;
  main) E=$MAIN_BINDING_SHA256;;
esac
if [ "$H" != "$E" ]; then echo "WRONG_BINDING $ARM $H"; exit 3; fi
R=$W/.c4b/results; mkdir -p "$R" "$W/.c4b/real"; [ -L "$W/.c4b/link" ] || ln -s "$W/.c4b/real" "$W/.c4b/link"
L=$R/$TAG-$ROOT-$ARM
{ echo "== $(date -u +%FT%TZ) $TAG-$ROOT-$ARM start load $(cut -d' ' -f1-3 /proc/loadavg)"; ps -eo pid,pcpu,etimes,args --sort=-pcpu | head -6; } >> "$R/load.log"
rc=0
NAPI_RS_NATIVE_LIBRARY_PATH=$N ADV_BASE=$W/.c4b/$ROOT timeout 2400 ${PREFIX:-} node "$W/bench/c4b/$DRIVER" "$TREE" "$ARM-$TAG-$ROOT" "$MODE" "$H" ${ONLY:+"$ONLY"} > "$L.jsonl" 2> "$L.stderr" || rc=$?
echo "== $(date -u +%FT%TZ) $TAG-$ROOT-$ARM end rc=$rc load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$R/load.log"
printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$TAG-$ROOT-$ARM" "$rc" "$H" "$N" >> "$R/commands.tsv"
grep -q '"type":"identity"' "$L.jsonl" || echo "NO_IDENTITY $TAG-$ROOT-$ARM"
grep '"type":"summary"' "$L.jsonl" | cut -c1-700 || echo "NO_SUMMARY $TAG-$ROOT-$ARM rc=$rc"
exit 0
