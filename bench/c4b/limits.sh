#!/bin/bash
# usage: limits.sh <arm> <set>; set is lim30real, lim30link, lim300 or unlimited.
set -uo pipefail
ARM=$1 SET=$2 A=$GITHUB_WORKSPACE/bench/c4b/arm.sh
C3=limit,limitrec,limitretry,limitdrop,limitdrop2-ctx,limitdrop2-file
C4=limitpart,limitctxroot,limitmc-starve,limitmc-even
ROOT=real; [ "$SET" != lim30link ] || ROOT=link
case $SET in
  lim30real|lim30link) export NSLIMIT=30 PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh;;
  lim300) export NSLIMIT=300 LIMIT_DIRS=400 PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh;;
  unlimited) ;;
esac
bash "$A" "$ARM" adv-c3.cjs "$SET" "$ROOT" "$C3"
bash "$A" "$ARM" adv-c4.cjs "c4$SET" "$ROOT" "$C4"
