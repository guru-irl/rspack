# Synthetic unplugin filter benchmark

This push-only benchmark compares released `unplugin@3.4.0`, a verified
filters-once dist patch, and no plugin with released `@rspack/core@2.2.8`.
It runs only on `bench/unplugin-filter` in the fork, on Ubuntu 24.04 and
Node 22.18.0. It does not build the repository.

The fixture contains 60,000 synthetic plain-JavaScript `.ts` modules plus
one entry. Three percent of leaf modules are in `routes/`. Both plugin
hooks use either a broad all-module include or the narrow routes include,
plus two string excludes. Transform is an identity operation; load returns
null. Every resource still traverses the function-valued rule callbacks.

Five interleaved repeats alternate arm and variant order. Each arm runs
cold against a fresh cache, then warm in a new process against its own
persistent newCache cache. Output bytes, module work, loader attachments,
cache restoration and package hashes are asserted. A positive median
broad cold patched-minus-stock wall delta triggers three additional cold
pairs with `NODE_OPTIONS=--max-semi-space-size=64`.

The artifact contains raw 10-ms anonymous-RSS and 50-ms loader-concurrency
traces, phase timestamps, V8 statistics and spaces, GC events, counters,
installation lock, dependency hashes, logs and a Markdown summary with
exact paired two-sided Wilcoxon tests. Timings end at the done hook;
cache close, output hashing and forced-GC controls are excluded.

Concurrency wraps actual loader lifetimes, preserving their completion
protocol, with no artificial delay. This common instrumentation can affect
timings. The broad cold probe establishes sensitivity, not a general
performance or retained-memory guarantee. With five pairs even unanimous
signs yield p=0.0625, so do not claim p<0.05 significance.
