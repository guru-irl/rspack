# Synthetic unplugin filter benchmark

Released `@rspack/core@2.2.8`, `unplugin@3.4.0`, Node 22.18.0 on GitHub-hosted Ubuntu 24.04. One generated fixture with 60,000 leaf modules and an entry. Broad filters match 60,001 modules; narrow filters match 1,800. Load returns null and transform returns the input code.

- U0: stock.
- U0prime: byte-identical stock for A/A memory controls.
- U2r2: lazy current-hook/cwd rule and resolveId filter caches, transform-loader WeakMaps with cwd invalidation, direct load-handler reads.
- RX: stock with equivalent RegExp filters precomputed before timing.

Speed uses five interleaved fresh-process cold/warm pairs per arm and variant, each warm process restoring only its own cold persistent cache. Timed samples do not force GC. Separate excluded controls force two GCs. Two excluded broad cold builds count resolveId filter reads before and after; the timed fixture has no resolveId hook to preserve the earlier comparison.

Fixed-young memory uses five interleaved U0/U0prime/U2r2 triples per variant, with `--min-semi-space-size=16 --max-semi-space-size=16` on every arm. Capture the cold endpoint, then force GC twice.

Watch memory uses five interleaved triples per variant, default V8 generation flags and one watch process per sample: initial build, 10 seconds idle, five alternating edits with 3-second gaps, then 10 seconds idle and two forced GCs. Rebuild wall includes the edit and watch debounce. The compiler stays live through the memory snapshots.

The three measurement series use separate runner jobs. Each records its own host, source commit, raw samples, GC events, output/work parity and integrity checks. Exact paired Wilcoxon tests enumerate signs with average ranks for ties and zeros dropped. At five nonzero pairs the minimum two-sided p is 0.0625. No causal, statistical-equivalence, production-memory or cross-platform guarantee is made.

The source-validation job applies the patch to upstream main `f2acf00e1f8e4fbeaa28f6660545c70c43cb2d73`, installs the frozen lockfile, lints, builds, typechecks and runs full `pnpm test`. Minimal registry dist patches preserve untouched adapters and published chunk names, and their manifests pin tarball and file integrity.
