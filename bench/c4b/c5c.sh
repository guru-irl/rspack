#!/bin/bash
# usage: c5c.sh <fix|base|main|wp>; external watch holder in the same user namespace, three repeats.
set -uo pipefail
ARM=$1 A=$GITHUB_WORKSPACE/bench/c4b/arm.sh
export PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh NSLIMIT=60
for i in 1 2 3; do bash "$A" "$ARM" adv-c5.cjs "c5hold$i-holder" real holder; done
