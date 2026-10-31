#!/bin/bash
# usage: replay-c5.sh <real|link>; the matrix, adv5 and c2 suites on fix and base, unlimited.
set -uo pipefail
ROOT=$1 A=$GITHUB_WORKSPACE/bench/c4b/arm.sh
C2=zunlink-true,zunlink-false,zlink-true,zlink-false,twin-true,twin-false,outa,outperm,ctxroot-true,ctxroot-false,ctxpair-true,ctxpair-false,manyctx,absentctx,scanfuzz,multi
for arm in fix base; do
  bash "$A" "$arm" matrix-counted.cjs matrix "$ROOT" -
  bash "$A" "$arm" adv5.cjs adv5 "$ROOT" -
  bash "$A" "$arm" adv-c2.cjs c2 "$ROOT" "$C2"
done
