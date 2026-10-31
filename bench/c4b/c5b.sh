#!/bin/bash
# usage: c5b.sh <fix|base|main|wp> <lim30real|lim30link|lim300>; recursive-pattern sessions, one process each.
set -uo pipefail
ARM=$1 SET=$2 A=$GITHUB_WORKSPACE/bench/c4b/arm.sh
S="async2-single async2-multi async2-sep"
run() { local tag=$1 root=$2; shift 2; for s in "$@"; do bash "$A" "$ARM" adv-c5.cjs "$tag-$s" "$root" "$s"; done; }
export PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh
case $SET in
  lim30real) export NSLIMIT=30; run c5blim30 real $S; run c5blim30rep real $S;;
  lim30link) export NSLIMIT=30; run c5blim30 link $S;;
  lim300) export NSLIMIT=300 LIMIT_DIRS=400; run c5blim300 real $S;;
esac
