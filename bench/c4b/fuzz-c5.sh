#!/bin/bash
# usage: fuzz-c5.sh; scanfuzz five times on fix and base, alternating, unlimited, real root.
set -uo pipefail
A=$GITHUB_WORKSPACE/bench/c4b/arm.sh
for i in 1 2 3 4 5; do for arm in fix base; do bash "$A" "$arm" adv-c2.cjs "fuzz$i" real scanfuzz; done; done
