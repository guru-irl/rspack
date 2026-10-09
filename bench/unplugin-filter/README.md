# Synthetic unplugin filter benchmark

This fork-only push benchmark compares released `unplugin@3.4.0` with
released `@rspack/core@2.2.8` on Ubuntu 24.04, Node 22.18.0:

- U0: untouched package with string filters.
- U1: hoisted rule `use`/`include` filters.
- U2: U1 plus per-hook WeakMap filter caches in all four rspack/webpack
  load and transform loaders. Only filters are cached. Handlers are read
  fresh on every call, including replacements on an existing hook object.
- RX: stock package, with the synthetic plugin's string patterns converted
  once to equivalent RegExps using `picomatch.makeRe` with `dot: true`.

The only intended behavior difference from stock is that filter changes
after first use are not seen. Replacing a hook creates a new cache key.
RegExp objects already referenced by a cached filter remain live.
Loader caches are module-local and do not retain hook keys strongly.

One shared fixture contains 60,000 synthetic plain-JavaScript `.ts` leaf
modules plus an entry. Broad filters match all 60,001; narrow filters match
1,800. Both hooks have two excludes. Transform returns code unchanged;
load returns null. Rule callbacks still traverse every resource visit.

Five interleaved repeats use a four-order balanced arm design followed by
one reverse-order repeat. Each arm runs cold against an empty cache, then
warm in a new process against its own persistent newCache cache. Variant
order alternates. No operating-system page-cache flush is performed.

Output bytes, callback and loader work, loader attachments, loader plugin
and hook identity, cache restoration and package/dependency hashes are
asserted. Actual loader lifetimes are wrapped identically with no artificial
delay. Shared instrumentation can affect absolute measurements.

Wall and process CPU finish in the done hook. Peak anonymous RSS is sampled
externally at 10 ms; endpoint anonymous RSS and V8 heap used/total/physical
are captured at done. GC events are filtered to the timed build window.
Output hashing, compiler close and cache persistence are excluded.

The 80 timing samples do not force GC. A further 16 excluded controls
(one cold/warm pair per arm and variant) force GC twice after parity checks.
Their post-GC footprints retain the compiler and compilation, so they are
not steady-state memory guarantees. With five paired samples the smallest
exact two-sided Wilcoxon p is 0.0625. Do not claim p<0.05 significance.

A focused regression first fails on stock and then checks all four patched
loaders, including fresh handler reads, replacements and transform id/code
filtering. The 3.3.0 compatibility patch is checked but not measured. A
separate runner builds and typechecks the source patch against v3.4.0 and
runs upstream unit tests, checking any failures against the stock baseline.
No repository Rspack build or unpublished binding is used.
