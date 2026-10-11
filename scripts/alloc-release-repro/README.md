# Synthetic allocator-release reproduction

This throwaway probe characterizes memory after a development MultiCompiler build. It does not modify Rspack, expose a private workload, or propose a fix.

The deterministic generator creates 45,000 shared JavaScript leaf modules plus 450 group modules and two entries. Each compiler processes the shared graph: browser/web and Node/CommonJS, development mode, `cheap-module-source-map`, no minimization. Outputs are real files. The compiler and stats stay reachable for 60 seconds after the MultiCompiler callback; there is no forced GC or post-build allocation stimulus. Compiler close is marked separately after the idle interval.

Run `.github/workflows/alloc-release-repro.yml` on the fork branch. The push pilot runs two launches with 24 functions per leaf. Dispatch accepts OS, package version, source size, number of launches and diagnostic arm. Packages come only from the public npm registry, with exact resolved versions, lockfile and registry provenance retained. `canary` resolves the current published canary, not necessarily an exact source commit.

An external Python observer samples at approximately 100 ms, retaining actual timestamps. Linux records RSS, RssAnon, swap and thread IDs/names from `/proc`. Other platforms record RSS and thread IDs via psutil, but do not claim RssAnon or thread-name attribution. Fresh processes run sequentially. Nonzero exits, timeouts and incomplete idle intervals are failures, not samples. Raw events, timelines, logs and summary files are artifacts.

The initial delayed-state screen is a >=256 MiB decrease in median anonymous RSS between 3–5 and 12–15 seconds after completion. It is only an operational screen: raw curves must be checked for slower releases, build-end releases and retained memory through 60 seconds. A correlation with disappearing `tokio-N` threads is not proof of page adoption or of which thread freed memory.

Diagnostic-only arms, not fixes: `MIMALLOC_PURGE_DELAY=0`; `MIMALLOC_PAGE_RECLAIM_ON_FREE=-1`; or separate exit statistics with `MIMALLOC_SHOW_STATS=1` and `MIMALLOC_VERBOSE=1`. These options exist in mimalloc 3.1.5. Baseline arms clear inherited mimalloc variables. The Node heap limit is 4 GiB across arms. No custom Tokio/Rayon thread count is set.
