# Spin-before-sleep memory gate (fork benchmark)

Synthetic only. This dispatch-only workflow is restricted to `guru-irl/rspack`.
It measures the opt-in Rayon knob without modifying production code.

The fixture is the deterministic wake fixture: 60,000 leaf modules in 120
synthetic packages, 52 roots and 12 entries. The original callback configuration
is retained: 112 regexp groups, six absent function tests, large/rare function
names, and the unnamed-chunk callback. No instrumentation bracket hooks are used.

Each hosted OS builds one release-profile binding using the repository build
script (`plugin,info-level`). A fresh measurement runner installs dependencies
and builds the JavaScript wrapper before measurement. All arms load that same
local native binding, whose SHA-256 is recorded.

```sh
node benchmarks/spin-memory-gate/run.mjs .spider/scratch/spin-memory-gate/results
python3 benchmarks/spin-memory-gate/analyze.py \
  .spider/scratch/spin-memory-gate/results/results.json summary
```

Four excluded warmups precede ten OFF/SPIN pairs and ten OFF/OFF pairs.
The treatment/control block order and each pair's launch order alternate.
Each launch creates a new Node process, performs a cold watch build and six
leaf edit/revert builds, pausing one second between edits. OFF removes both spin
variables before startup; SPIN sets rounds=2048 and mode=yield before startup.
Pool sizes use the runner defaults and remain unchanged across arms.

After the last edit the measured process stays idle for ten seconds, sampling
RSS every half second. Steady memory is the median of the last five samples.
Linux additionally reads its own `/proc/self/status` RssAnon. Node's
`process.resourceUsage().maxRSS` is the process-wide native high-water mark in
KiB on all three platforms: libuv normalizes macOS bytes, and Windows uses
`GetProcessMemoryInfo().PeakWorkingSetSize / 1024`. It is read after compiler
shutdown. Windows RSS is resident working set, not private commit.

Memory samples are taken before materializing logger stats. Per-build wall and
process CPU cover the watch callback; total process CPU includes startup,
logger capture, edit pauses, settling and shutdown. SplitChunks duration is the
actual `process cache groups` time from compilation logging, not an outer hook.
There is no forced GC or allocator purge. RSS includes JavaScript and native
memory. Fixture generation is outside the measured process.

Errors, missing logger durations, incomplete builds, unsupported maxRSS,
shutdown errors, subprocess failures and timeouts fail the run. The analyzer
requires all 44 launches and all metrics; failed launches are never samples.
It reports signed paired median/range deltas and counts memory pairs strictly
above the corresponding signed A/A maximum. The no-increase gate requires the
paired median not above that maximum and zero excess upper tails for peak,
steady and each individual edit RSS (plus Linux anonymous memory). Reductions
below the lower A/A bound are allowed because they are not memory increases.
Time and CPU are reported but are not the gate. A/A is an empirical noise band,
not a confidence interval. A finite synthetic run cannot prove all workloads.

Generated fixtures, output bundles and raw logs are scratch data, not committed.
