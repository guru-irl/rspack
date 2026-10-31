#!/bin/bash
# usage: c5e.sh <fix|base|main|wp>; a peer closes while c0 hits the limit, at several delays.
set -uo pipefail
ARM=$1 A=$GITHUB_WORKSPACE/bench/c4b/arm.sh
export PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh NSLIMIT=30
for d in 0 25 50 75 100 150 200 300 0 50 100 200; do CLOSE_DELAY=$d bash "$A" "$ARM" adv-c5.cjs "c5close$d-$RANDOM" real closing; done
