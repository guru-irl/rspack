# Fixed-latency cache-open measurement

Measurement only; never for upstream.

Dispatch `Cache slow-disk bindings` on `bench/newcache-e-slowdisk`, then dispatch `Cache slow-disk comparison` with the successful build run ID. Both workflows are dispatch-only and guarded to the measurement fork. They do not edit an existing pull request.

## Comparability

- Fixed round-2 and round-3 revisions, ci-profile Linux x64 bindings, Node 24 and pnpm 11.26.0. A single round-3 JavaScript build serves every arm through `NAPI_RS_NATIVE_LIBRARY_PATH`. Binding and JavaScript SHA-256 checks are required before measurement.
- The supplied synthetic generator is unchanged except that `FIXTURE` selects its output directory. 60,000 generated JavaScript modules produce 72,061 graph modules, including CSS and generated packages. 30,000 is an explicit fallback option only if the larger corpus cannot fit; it must be reported, never mixed within a series.
- A direct-I/O sparse-file loop backs a dm-delay mapper with ext4 `data=ordered`. Read delays are 0, 1 and 3 whole milliseconds. Writes receive zero added delay. All arms use this same stack, including the zero-delay control. Failure to load the delay target stops the measurement with diagnostics.
- Seed once at zero delay using round 3. Copy the seed with `cp -a` into the same cache path for every run. Compiler configuration, project, output path and build dependencies are identical across arms. Only the native binary and the disable-prefetch environment variable vary.
- Each run syncs and drops page caches, then checks every regular cache file with `mincore` without reading its contents. Nonzero residency aborts. Project, dependencies and bindings are on the normal filesystem, but dropping caches affects them too. Their cold-start contribution is shared across arms and included in wall/build timings.
- Five rounds per delay. Arm order rotates: round 3, round 2, disabled; round 2, disabled, round 3; disabled, round 3, round 2; repeat. Delays run sequentially 0, 1, 3 ms. Five rounds do not balance order perfectly, and delay order is not randomized.
- Every successful warm start must report the full graph as `stillValidModule`, zero `buildModule` calls and no compilation errors. Failed commands and partial series are not samples or a valid summary.

## Metrics

Build time starts immediately before compiler creation and ends at the done hook. Make is the make hook through finishModules. Process wall and user/system CPU include process launch, JavaScript loading, cache open, build, logging and compiler close. Device read request/sector counters are captured immediately before launch and after exit; they exclude cache copying, sync, eviction, the residency probe and removal. Sector counts use the kernel's 512-byte units.

Anonymous RSS is sampled every 100 ms across process lifetime. End anonymous RSS is read by the driver immediately after build, before close. No forced garbage collection is performed. VmHWM is the maximum of driver checkpoint, sampled high-water marks and `wait4` peak RSS. Sampling can miss a short anonymous-RSS peak. VmSwap and available-memory records help identify memory pressure. A Linux-only experiment does not establish memory impact on other platforms.

The prefetch log records files, bytes and time when present. Round 3's byte/time counts describe advisory ranges submitted, not I/O completion. Round 2's counts describe completed copying reads; the two log timers therefore are not equivalent. Prefetch can be cancelled before scanning all files.

Analysis uses median and full range, and paired round-3-minus-comparator differences within each round. Wilcoxon p is exact and two-sided by enumerating sign assignments, using average ranks for ties and omitting zero differences. Five nonzero pairs cannot produce p below 0.0625. No multiplicity correction or significance claim is made. Added delay is per block request, not a model of every physical slow disk.
