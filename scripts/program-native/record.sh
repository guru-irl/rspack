#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD"
export DEBUGINFOD_URLS=''
MODE=${1:-both}
if [ "$MODE" != export ]; then
for round in 1 2 3; do
  OUT="$ROOT/bench-data/results/repeat-$round"
  mkdir -p "$OUT"
  cd "$OUT"
  export JITDUMPDIR="$OUT"
  echo "Recording repeat $round at $(date -u +%FT%TZ)"
  "$PERF" record --no-buildid --no-inherit -k 1 -e cpu-clock -F 499 --call-graph dwarf,16384 -o perf.data -- \
    node --perf-prof --perf-prof-unwinding-info --interpreted-frames-native-stack \
    "$ROOT/scripts/program-native/run.mjs" "$ROOT/bench-data/fixture" "$OUT/metrics.json" 2>record.log || { tail -80 record.log; exit 1; }
  tail -4 record.log
  cd "$ROOT"
done
fi
if [ "$MODE" != record ]; then
for round in 1 2 3; do
  OUT="$ROOT/bench-data/results/repeat-$round"
  cd "$OUT"
  PID=$(python3 -c 'import json; print(json.load(open("metrics.json"))["pid"])')
  echo "Injecting repeat $round at $(date -u +%FT%TZ)"
  timeout 240 "$PERF" inject -j -i perf.data -o perf.injected.data 2>inject.log || { tail -40 inject.log; exit 1; }
  echo "Exporting repeat $round at $(date -u +%FT%TZ)"
  timeout 240 "$PERF" script --addr2line "${ADDR2LINE:-addr2line}" --inline --ns --tid "$PID" -i perf.injected.data -F comm,pid,tid,time,event,ip,sym,dso > perf.script 2>script.log || { tail -40 script.log; exit 1; }
  timeout 90 "$PERF" script --no-inline --ns --tid "$PID" -i perf.injected.data --show-mmap-events --max-stack 1 | grep -E 'PERF_RECORD_MMAP|MMAP2' > mmap.txt || true
  timeout 90 "$PERF" report --no-inline --stdio --tid "$PID" -i perf.injected.data --no-children --percent-limit 0.2 > self.txt 2>report.log || { tail -40 report.log; exit 1; }
  timeout 90 "$PERF" report --no-inline --stdio --tid "$PID" -i perf.injected.data --children --percent-limit 0.5 > inclusive.txt 2>>report.log || { tail -40 report.log; exit 1; }
  timeout 180 "$PERF" script --addr2line "${ADDR2LINE:-addr2line}" --inline --ns --tid "$PID" -i perf.injected.data -F comm,pid,tid,time,event,ip,sym,dso,srcline > source-lines.script 2>source-lines.log || true
  cd "$ROOT"
done
fi
