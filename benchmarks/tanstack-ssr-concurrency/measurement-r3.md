# Four-compiler measurement registration

Primary metrics: default versus stock warm span (leaf, function body), and peak RSS (cold, warm leaf, warm body). Span is first watchRun to final done across all compilers, not just client and SSR.

Ten paired groups for each scenario, exactly five forward (stock, gate-only, default) and five reverse. Fresh processes, ten warm edits per process, external RSS/VmHWM at 10 ms. Warm inference uses process medians. HL Walsh paired estimate and exact conditional two-sided Wilcoxon 95% inversion intervals. Descriptive, unadjusted; a positive memory lower bound detects an increase, a zero-spanning interval is not proof of no increase. Failed runs never provide samples.

Secondary metric: client passes per edit, for every arm and scenario on Rsbuild 2.2.12 and 2.2.2. Retain every replayed pass in all-compiler span, per-compiler sums, pass counts and memory. Report distributions and pooled default-versus-stock two-sided Fisher exact tests for edits with more than one client pass. Cold counts are per startup, not per edit.

Settlement for all arms: every compiler idle, no observed or native pending invalidation, at least 1,000 ms after the last done (and last hook event). This replaces the previous 800 ms rule. Post RSS is sampled at last done + 1,000 ms. Failed commands never contribute samples. Freshness requests are after compilation settlement and outside the compilation span; identical in all arms.

Pass classes: normal, write-driven attach, pure replay, Start-attributed, unknown (stop). Report every class by arm, compiler, version and checkpoint/scenario. Separate default-versus-stock two-sided Fisher tests for checkpoints with a pure replay and with a write-driven attach pass. Single-save count assertions keep exact non-replay expectations; rapid scenarios allow one to k non-replay passes for k deliberate saves, plus independently Start-attributed work.
