# SplitChunks wake census

Fork-only measurement code based on `86e4cf5ffebf098b5056b291525e0d3f44556052`. Never upstream. No optimization, pool policy, allocator setting, or user-facing API change is intended.

`RSPACK_SC_CENSUS=<absolute JSONL path>` enables slow-path Rayon counters and buffered site records. Unset or empty disables both; there is no sampler. `RSPACK_SC_CENSUS_MODE=controlled` enables diagnostic completion waits. Natural scheduling is authoritative. Controlled timing and notifications are not acceptance evidence.

Counters are `[cold entries, cross-pool entries, external injections, notifications, sleeps]`. CPU arrays are `[user microseconds, system microseconds, voluntary switches, involuntary switches, lifetime ru_maxrss]`. `ru_maxrss` is KiB on Linux and bytes on macOS; it is not macOS physical footprint. Each site includes monotonic start/end, input length, minimum job length, initial sleeping/inactive workers, preceding gap, and priority/attempt context. Records are bounded to 250,000 per invocation. Output occurs only at process exit, after completion of measured asynchronous drops.

Parent intervals, child terminals and async closures are nonexclusive. Rank nonoverlapping work families and retain closure-overlap ranges. Site savings sums are upper bounds, not predictions: deleting one site changes the next site's pool residency. Re-census after each future retained step.

`series.py` first checks qualification using the unchanged baseline algorithm with controlled census enabled. It does not benchmark a failed arm. Successful arms freeze SHA256 hashes before five alternating fresh-process on/off pairs per normal host and real Linux three-core affinity, then three controlled fresh processes. Cold/edit/revert are correlated phases. It also checks asset-byte manifests and callback counts against the original binary and census-disabled binary in the identical fixture directory. Results include failed-qualification receipts.

Every large arm explicitly uses development mode, dedupDepth zero and usedExports false. Target arms: priority native, priority callback, mixed selective. Mixed saturated and every-priority-winner are non-regression guards, not 40% wake targets.

The generators use only public generic integer topology. Generated sources live under the ignored scratch directory, not in the source tree. Many-route parameters are qualification hypotheses, not achieved measurements. A generator that misses a target must be revised and requalified before timings support a recommendation.

The workflow builds release artifacts with an explicit Rust target. Original baseline sources are restored and touched before its separate build to prevent stale same-version crate reuse. Build logs, source/artifact hashes, host receipts, raw JSON/JSONL, parity checks and qualification failures are preserved.

This census does not itself validate a production optimization or meet the later CPU/memory acceptance gates. Missing kernel footprint, phase high-water, retained-growth, Callgrind, or functional-suite evidence must never be represented as passing those gates.
