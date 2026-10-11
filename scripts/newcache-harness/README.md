# New-cache sanity harness

This fork-only harness compares two public source revisions on one host. Change `config.json` with full source SHAs, fixture size, interleaved pair count and A/A count, then enable it. A push to `bench/newcache-harness` runs macOS and Windows. Concurrency is grouped by branch; a newer push cancels its superseded run without affecting other bench branches. Linux uses the same scripts locally. Do not copy these scripts onto a production branch.

Both release bindings are built within the measuring job, before any pairs. The job never packages or transfers a runtime. Uploads are restricted to JSON, CSV and logs. Build targets are removed after each arm to leave room for the next source build; source worktrees and runtime files remain on the measuring host.

## Run

Use Node 22.18.0, the repository pnpm version and pinned Rust toolchain. Set `HARNESS_WORK` to an absolute, disposable directory, and `HARNESS_RESULTS` to an absolute metrics directory. Set `RUST_TARGET` to the native target. Run `python scripts/newcache-harness/launch.py scripts/newcache-harness/config.json` from the harness checkout. On Windows use native Windows paths for these environment variables. Linux builds and measurement must be coordinated separately with the machine's exclusive build/measurement controls: run `build.py` under the build lock, then `series.py --prepare` under the build lock to create untimed fixtures/closed seeds, followed by `series.py` under the measurement lock with `CORE_A` and `CORE_B` from `cores.json`.

The generator is copied from `scripts/newcache-parity/gen.mjs`. Only its output path and Windows-compatible file-URL decoding change. Source and generator hashes, binding sizes/hashes, tools, host and exact arms are saved in `provenance.json`.

Each arm has its own cold seed. Cold processes complete idle work, close, and exit successfully before their cache becomes a seed. They collect module cardinality and output hashes but no time or memory samples. Each fresh warm process receives an independent `copy2` copy of its arm's closed seed, preserving file timestamps. The fixture path and source timestamps stay identical. Every pair compares byte hashes of all emitted files against both cold builds. A/A runs precede the five A/B pairs; pair execution alternates AB and BA. Sources, packages and cache bytes are preread before every warm run. No page-cache eviction or private fixture is used.

## Anchors and counters

Warm wall and combined user/system CPU start after importing the public core API and stop at public JavaScript done. No graph enumeration or per-module counters occurs in timed processes. Done memory is sampled there. END is two seconds after an observed successful idle completion, compiler still alive, following forced JavaScript GC. Post-close is after close returns successfully and forced GC. Parents acknowledge each anchor so Windows cannot exit before its exact counters are sampled. Parent timeline sampling every 50 ms records Linux sampled anonymous peak, distinct from VmHWM. Lifetime kernel peaks at post-close are also retained.

- Linux: current RssAnon, RssFile, VmRSS and exact VmHWM from `/proc`. VmHWM includes file-backed pages and is not anonymous peak.
- macOS: exact current and lifetime-max physical footprint through `proc_pid_rusage(RUSAGE_INFO_V4)`.
- Windows: `GetProcessMemoryInfo(PROCESS_MEMORY_COUNTERS_EX)` private bytes, PeakPagefileUsage (peak commit), working set and peak working set, from the parent process.

## Observation patch

`idle-completion.patch` is applied identically to both source worktrees before release builds. It only logs after `after_all_stored` returns, covering store, compaction passes and stale cleanup. It distinguishes an interrupted idle epoch from completion. Any cache warning/error or interrupted/missing completion fails the run. There is no production format, allocator, capacity or lifetime change in this patch. Its SHA-256 is recorded in provenance. Patch application is checked against main, the compression branch and N+ `0dffff63a1` before publishing the harness.

The after-all-stored wrapper logs failures rather than returning them. The harness therefore checks captured warnings as well as completion; a completion log never overrides a failure. The fixture does not schedule another build or interrupt idle before END.

## Failure and memory policy

Any nonzero command, missing counter/anchor, invalid cache, output mismatch or infrastructure failure invalidates the run. ENOSPC is never a sample. Raw successful observations, pair order and sampled timelines remain in JSON. The summary reports median and worst candidate-minus-baseline paired deltas, not differences of aggregate medians. For every memory counter and anchor it compares the worst A/B delta to the largest absolute A/A delta, with a zero floor. Any increase beyond this measured A/A envelope makes the command fail and blocks recommendation. A small sanity run is not a general memory-safety or performance proof. Host samples record CPU count and load average where available, plus Linux available memory before each process. Disclose background load and do not drop slow successful samples.
