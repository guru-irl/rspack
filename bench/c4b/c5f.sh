#!/bin/bash
# usage: c5f.sh <fix|base|main|wp>; recursive add fails under an external holder, then quota is freed.
set -uo pipefail
ARM=$1 A=$GITHUB_WORKSPACE/bench/c4b/arm.sh
export PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh NSLIMIT=60
for i in 1 2 3; do bash "$A" "$ARM" adv-c5.cjs "c5cov$i-covhold" real covhold; done
