#!/bin/bash
# The retained-folder case at limit 30 on the real root: calibrate the fillers on fix, reuse them on the other arms.
set -uo pipefail
A=$GITHUB_WORKSPACE/bench/c4b/arm.sh R=$GITHUB_WORKSPACE/.c4b/results
export NSLIMIT=30 PREFIX=$GITHUB_WORKSPACE/bench/c4b/nslimit.sh
unset LIMIT_FILLERS
bash "$A" fix adv-retained-folder.cjs lim30-retained real limitretain
LIMIT_FILLERS=$(grep '"type":"fill-meta"' "$R/lim30-retained-real-fix.jsonl" | sed -E 's/.*"fillers":([0-9]+).*/\1/')
echo "fillers=$LIMIT_FILLERS"
export LIMIT_FILLERS
for arm in head main wp; do bash "$A" "$arm" adv-retained-folder.cjs lim30-retained real limitretain; done
unset NSLIMIT PREFIX LIMIT_FILLERS
for arm in fix head main wp; do bash "$A" "$arm" adv-retained-folder.cjs unlimited-retained real limitretain; done
