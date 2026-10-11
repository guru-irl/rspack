# Legacy persistent-cache warm restore IO study

Measurement only; never for upstream. Public synthetic source and GitHub-hosted Ubuntu 24.04 only.

Base: f2903b6482cb7a0fcdca912d23062bd94d3d5636. Baseline and prototype bindings have identical timestamped storage-load instrumentation. The prototype adds two measurement-only environment switches; neither is a proposed user option.

- Main, Tokio core workers at 2x and 4x runner logical CPUs, and blocking cap 32 control.
- A: native Linux WILLNEED in 128 KiB ranges over every cold pack, before demand reads start. Default no-op on non-native filesystems.
- B: per-bucket dedicated 16-worker Tokio IO runtime with 256 KiB thread stacks, a bounded 16-result channel, at most 16 active pack reads, and 128 KiB native read buffers. The NAPI blocking pool is unchanged. Runtime shuts down after that bucket finishes. No whole-file copy buffers.
- A+B: both switches.

10,000 generated JS modules with 120,000 source bytes each. The seed must contain at least 1 GiB of `.pack` files or the workflow fails before counting samples. Development mode, no source maps or minification, incremental off, legacy persistent cache.

One closed baseline seed on ext4/dm-delay/direct-I/O loop, copied with timestamps preserved to the same cache path for every launch. Global `sync; echo 3 > /proc/sys/vm/drop_caches` before evicted launches; complete mincore residency check. Warm 0 ms explicitly reads the whole cache first and must be 100% resident. Output parity SHA-256, zero buildModule warm hits and no process swap are mandatory. Source and binding pages are also globally chilled by eviction.

Warm-start time spans run invocation through completion callback, excluding compiler creation, parity hashing and close. Storage timer spans `FileSystemStorage::load`; make-restore time uses the existing compilation logger. END RSS is read immediately after the callback without GC. Lifetime peak RSS uses kernel VmHWM and wait4; anonymous peak and D-state samples have a 50 ms nominal interval. D-state sampling is clipped to storage windows, not a kernel IO-wait counter. Preserve raw data and failed commands; no failures become samples.

Five rotating, interleaved exploratory rounds per condition; n>=10 paired deciding run required before acceptance. Paired median plus exact Wilcoxon-HL 95% interval, bootstrap median cross-check. At n=5 the exact interval is necessarily unbounded. Time win requires upper bound below zero, memory increase means lower bound above zero and blocks acceptance. Non-significance is not an equivalence proof.

The experimental Linux FFI declaration is for the measured Linux x64 target only. Any production implementation requires a platform-correct binding, default no-op for unsupported or custom filesystems, no new options or cache format changes, and cross-platform validation. Prototype buffers affect native cache streams, including metadata/hot packs. B's buffering and scheduling are deliberately combined as one exploratory arm; separate them if needed to choose a minimal implementation.
