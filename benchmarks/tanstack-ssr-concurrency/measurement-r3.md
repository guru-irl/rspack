# Four-compiler measurement registration

Primary metrics: default versus stock warm span (leaf, function body), and peak RSS (cold, warm leaf, warm body). Span is first watchRun to final done across all compilers, not just client and SSR.

Ten paired groups for each scenario, exactly five forward (stock, gate-only, default) and five reverse. Fresh processes, ten warm edits per process, external RSS/VmHWM at 10 ms. Warm inference uses process medians. HL Walsh paired estimate and exact conditional two-sided Wilcoxon 95% inversion intervals. Descriptive, unadjusted; a positive memory lower bound detects an increase, a zero-spanning interval is not proof of no increase. Failed runs never provide samples.
