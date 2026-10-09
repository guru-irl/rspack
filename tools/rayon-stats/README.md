# Rayon slow-path measurements

Measurement only; never for upstream. The vendored Rayon core keeps scheduling unchanged.

## MultiCompiler diagnostic run

Set absolute, new files for each Node process. The parent directories must already exist:

```sh
RSPACK_RAYON_STATS=<absolute-path-to-samples.csv> \
RSPACK_RAYON_STATS_INTERVAL_MS=5 \
RSPACK_RAYON_MARKS=<absolute-path-to-marks.jsonl> \
node <build-command>
```

`RSPACK_RAYON_STATS` enables one process-global sampler on the first outside Rayon injection or blocking call. The positive integer interval defaults to 5 ms. With only stats set, samples are available but compiler windows cannot be attributed. `RSPACK_RAYON_MARKS` enables Rust pass start/end marks and the plugin's JS hook marks in the same append-only JSONL file. With only marks set, timings and compiler-overlap analysis are available, but no sampled wake counts or CPU deltas can be joined. Neither variable depends on the other. The interval alone does nothing. With both stats and marks unset, there is no sampler, file, OS CPU sampling or duration clock read; only slow-path atomic event increments and an Option check at pass boundaries remain. With stats unset but marks set, marks still use the clock and append to the marks file, but Rayon duration counters and OS sampling remain off. Duration totals and histograms are collected only while stats are enabled. A failed output open disables sampling and writes a diagnostic to stderr.

Apply the plugin to every config, not just the client:

```js
const RayonMarksPlugin = require('./rayon-marks-plugin.cjs');

function addRayonMarks(configs, diagnosticSerial = false) {
  const marked = configs.map(config => ({
    ...config,
    plugins: [...(config.plugins || []), new RayonMarksPlugin()],
  }));
  if (configs.parallelism !== undefined) marked.parallelism = configs.parallelism;
  if (diagnosticSerial) marked.parallelism = 1;
  return marked;
}

// Config names such as "client" and "ssr" appear in each mark.
module.exports = addRayonMarks([clientConfig, ssrConfig, ...otherConfigs], true);
```

`parallelism` is a top-level property on the config array, not on the individual configurations. For a clean diagnostic run, set `configs.parallelism = 1`. Set `diagnosticSerial` to false to retain normal concurrent operation (and preserve the original array's parallelism if specified).

Every mark contains a decimal string nanosecond `timestamp_ns`, `compiler`, `compiler_id`, `compilation_id`, `build`, `source`, `pass`, `event`, and `hook`. JS marks carry `compiler.name` as `compiler`, a per-compiler `build` sequence and `source: 'js'`. Rust marks carry the compilation options name (or `compiler-<native-index>` if unnamed), native compiler and compilation IDs, the pass's own name, `event: 'start'|'end'`, and `source: 'rust'`. The analyzer matches named native compilation intervals to their enclosing JS compile-to-done build for run/phase and overlap metadata. All six config names should be unique. An ambiguous unnamed match is reported, not silently attributed. State is scoped to each compiler or compilation. There is no global build counter. Multiple plugin instances on the same compiler are deduplicated with a compiler-local symbol. Different compilers and instances append to one file using one synchronous append per complete JSON line; no shared buffered writer or truncation is used. Use one marks file per Node process. Give all six compilers meaningful names; distinct compiler IDs also avoid anonymous-name collisions.

**Attribution caveat:** Rayon counters are process-global. All compilers share the same global pool, and the counters also include any additional Rayon pools in the process. When client and ssr windows overlap, their wakes, CPU time and context switches cannot be split between them. Each window reports `overlap_ms` and `overlap_pct`, computed as the union of other compilers' compile-to-done intervals, not their sum. `overlap_flag` is true above 10%. Concurrent results are supported, but flagged rows are shared-process observations, not compiler-exclusive costs. The script groups by compiler ID and build, supports six or more compilers and arbitrary rebuild counts, and does not invent builds for compilers that did not rebuild after an edit. Rust pass rows have exact start/end hook times, while cumulative-counter attribution retains the sampler's boundary resolution. Without explicit fixture labels, build 1 is labeled cold and subsequent builds rebuild; revert cannot be inferred automatically.

Run the join with:

```sh
node analyze-wakes.mjs <samples.csv> <marks.jsonl> <output-prefix>
```

This produces JSON and CSV with each exact Rust pass interval plus JS outer intervals. JS tail detail rows are explicitly marked `detail` and overlap their outer summary; do not add them to a sum of primary rows. JS-only consecutive hook intervals are used when native pass marks are absent. For marks-only timing and overlap analysis use `-` instead of the sample filename. Use separate files per process: cumulative counters reset across processes, and the analyzer rejects resets and incomplete compile-to-done builds. Sample output is append-only with one header for an empty file; reusing a previous process's file is not supported by the join.

## Clock, counters and resolution

Linux uses `clock_gettime(CLOCK_MONOTONIC)`; macOS uses `clock_gettime(CLOCK_MONOTONIC_RAW)`. These match the verified Node's `process.hrtime.bigint()` epoch and rate. On Node 22.23.1 / libuv 1.51.0, macOS CLOCK_UPTIME_RAW excludes time asleep and does not match hrtime; the measurement uses CLOCK_MONOTONIC_RAW instead. Verify alignment on a different Node/libuv version before joining timestamps. Sampling is disabled on other platforms. A final cumulative sample is written through `atexit` on normal process exit; forced termination does not guarantee one.

Each requested global AtomicU64 has 128-byte alignment and Relaxed operations. Event sites are outside injection, `in_worker_cold`, `in_worker_cross`, a successful sleeping-worker notification, and each actual condvar wait. No instrumentation is added to internal join, local deque push or steal loops. `injected` includes broadcast queue jobs. `cold_ops` counts entry, while `cold_ns` and histogram buckets count completed blocking calls. Blocked time includes dispatch plus waiting, not just condvar time. A call spanning hook windows is charged on completion; concurrent blocked callers can give a duration share over 100%. This is a completed-call sum, not the percentage of wall time with a caller blocked.

Histogram intervals in microseconds are [0,10), [10,30), [30,100), [100,300), [300,1000), [1000,3000), [3000,infinity).

The sampler reads Linux `/proc/self/stat` utime/stime and converts the kernel tick counts to nanoseconds. macOS uses `getrusage(RUSAGE_SELF)` CPU times. Both use `getrusage` voluntary context-switch totals. Minor and major page faults are cumulative Linux `/proc/self/stat` fields 10 and 12 (minflt/majflt), or macOS `getrusage` ru_minflt/ru_majflt. The analyzer reports their deltas beside wake and CPU deltas. These are process-wide, include the sampler and JavaScript, and exclude child processes. Linux CPU deltas are quantized to the system's clock ticks, usually 10 ms. CPU and counters are not an atomic snapshot.

The analyzer subtracts the preceding cumulative sample at each hook boundary, without inventing fractional event counts. It reports boundary skew, the maximum observed sample gap, `sampling_limited` for shorter windows and `sample_clipped` outside sample coverage. Sub-interval rows are timing observations, not reliable fine-grained wake or CPU attribution. The 5 ms interval is a request, not a scheduling guarantee. On/off runs measure sampler overhead; compare an unpatched main build separately if measuring the unconditional atomic-counter cost.

## Fine-grained pass windows

The compilation pipeline is an ordered pass list in `crates/rspack_core/src/compilation/run_passes.rs`. The runner writes one start and one end mark around every pass, including make/build-module-graph and finish phases, using an open-append-write for each complete line. The env-unset path checks an Option only. Module IDs, chunk IDs, module hashes, code generation, runtime requirements, compilation/chunk hashes, module assets and chunk assets have exact native pass boundaries. `CreateModuleHashesPass` runs before `CodeGenerationPass`, not inside `CreateHashPass`. Several requested webpack-style JS hooks are not exposed on this base; no hooks are invented or public APIs added. Read the native pass map supplied with the measurement report.

The JS plugin records only argument-light compiler hooks: compile, thisCompilation, make, finishMake, afterCompile, emit, afterEmit, and done. It does not tap beforeModuleIds, afterOptimizeModules, optimizeTree, optimizeChunks, chunkAsset, or any collection-valued compilation hook. Ignoring an argument in the callback does not prevent the Rust/JS bridge from materializing the collection. Optional JS processAssets hooks are also omitted: the native ProcessAssetsPass already provides an exact boundary. Native CreateModuleAssetsPass and CreateChunkAssetsPass separate module asset creation from chunk rendering without per-chunk callbacks.

Optional `new RayonMarksPlugin({ getContext: () => ({ run, phase }) })` metadata labels are useful in a fixture. The plugin itself owns the identity, build and timestamp fields; these cannot be overridden by metadata.

## Fixture comparability

Run every build from the same fixture directory, switching builds with `--rspack <installed package dir>`. SplitChunks breaks ties between equal candidate groups by module identifiers, which contain absolute paths. The generated modules are nearly uniform in size, so ties are common, and the same build can produce a different, but repeatable, chunk graph from a different directory.

Use one fixture directory for all arms and on/off settings on each host. Cross-host absolute paths still differ; report chunk cardinalities rather than assuming identical graphs.

## Allocator diagnostic

On Linux, compare a fresh process with the default allocator setting against `MIMALLOC_PURGE_DELAY=-1`. This is a diagnostic, not a memory-neutral fix: retaining freed memory can raise resident memory. Interleave repetitions and keep the fixture directory unchanged. Use `MIMALLOC_SHOW_STATS=1` once per condition and retain stderr to inspect purge, commit, and reset counts.

`monitor-rss.py <metadata.json> <stdout.log> <stderr.log> -- <command>` samples `/proc/<pid>/status` externally every requested 5 ms. It records sampled RssAnon peak and the last live value before exit, excluding zombie observations. The peak is sampled, not an exact high-water mark. Its own CPU is outside the measured process; report this observer and apply it to both conditions.
