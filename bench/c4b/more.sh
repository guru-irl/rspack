#!/bin/bash
# usage: more.sh <arm> <lim300|rep30>
set -uo pipefail
ARM=$1 SET=$2 A=$GITHUB_WORKSPACE/bench/c4b/arm.sh
C3=limit,limitrec,limitretry,limitdrop,limitdrop2-ctx,limitdrop2-file
export PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh
case $SET in
  lim300)
    export NSLIMIT=300 LIMIT_DIRS=400
    bash "$A" "$ARM" adv-c3.cjs lim300 real "$C3"
    bash "$A" "$ARM" adv-c4.cjs c4lim300 real limitpart,limitctxroot,limitasync,limitmc-starve,limitmc-late,limitsep-starve,limitmc-even;;
  rep30)
    export NSLIMIT=30
    for i in 1 2 3; do bash "$A" "$ARM" adv-c4.cjs "rep$i" real limitasync,limitmc-starve,limitmc-late,limitsep-starve; done;;
esac
