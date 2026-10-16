#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD"
for round in 1 2 3; do
  OUT="$ROOT/bench-data/results/repeat-$round"
  mkdir -p "$OUT"
  cd "$OUT"
  "$PERF" record --no-inherit -e cpu-clock -F 499 --call-graph dwarf,16384 -o perf.data -- \
    node --perf-prof --perf-prof-unwinding-info --interpreted-frames-native-stack \
    "$ROOT/scripts/program-native/run.mjs" "$ROOT/bench-data/fixture" "$OUT/metrics.json" 2>record.log
  PID=$(python3 -c 'import json; print(json.load(open("metrics.json"))["pid"])')
  "$PERF" inject -j -i perf.data -o perf.injected.data 2>inject.log
  "$PERF" script --ns --tid "$PID" -i perf.injected.data -F comm,pid,tid,time,event,ip,sym,dso > perf.script 2>script.log
  "$PERF" report --stdio --tid "$PID" -i perf.injected.data --no-children --percent-limit 0.2 > self.txt 2>report.log
  "$PERF" report --stdio --tid "$PID" -i perf.injected.data --children --percent-limit 0.5 > inclusive.txt 2>>report.log
  cd "$ROOT"
done
