#!/bin/bash
# usage: c5.sh <fix|base|main|wp> <lim30real|lim30link|lim300|busy>; one process per session.
set -uo pipefail
ARM=$1 SET=$2 A=$GITHUB_WORKSPACE/bench/c4b/arm.sh
S="async-single async-multi async-sep share gen"
run() { local tag=$1 root=$2; shift 2; for s in "$@"; do bash "$A" "$ARM" adv-c5.cjs "$tag-$s" "$root" "$s"; done; }
case $SET in
  lim30real) export NSLIMIT=30 PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh; run c5lim30 real $S;;
  lim30link) export NSLIMIT=30 PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh; run c5lim30 link $S;;
  lim300)
    (export NSLIMIT=300 LIMIT_DIRS=400 PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh; run c5lim300 real $S)
    (export LIMIT_DIRS=40; run c5unlim real $S);;
  busy) export NSLIMIT=2000 LIMIT_DIRS=2500 BIG_DIRS=800 PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh; run c5busy real busy-r1 busy-r2 busy-r3;;
esac
