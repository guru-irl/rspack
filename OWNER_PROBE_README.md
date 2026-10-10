# Measurement-only owner probe

This Linux x64 GNU pack adds owner attribution to the existing live-heap build. It is not a performance change and is not intended for production or upstream merging. All launches using it must remain excluded from timing.

## Enable and trigger

Set before starting Node:

```sh
export RSPACK_OWNER_PROBE_LOG=/absolute/writable/path/owners.jsonl
# Optional independent live-heap time series:
export RSPACK_LIVE_HEAP_LOG=/absolute/writable/path/heap.tsv
```

`RSPACK_OWNER_PROBE_LOG` alone enables counting from the first Rust allocation, automatic snapshots, per-build cache counters, and one process-wide `owner-probe` signal thread. With it unset there is no owner-probe signal handler, thread, registration, counter collection, or snapshot. The pre-existing live-heap logger remains independently available.

Allow cache idle storage/compaction to finish (at least 65 seconds after the final rebuild for this validation). After the END sampling window, immediately before teardown, send:

```sh
kill -USR2 <dev-server-pid>
```

Wait for an `end_complete` JSON line, then tear down. **END clears cache memory and must be the last action before teardown. Do not rebuild, request lazy compilation, or continue the server afterwards.** Pending writes are counted but never dropped. SIGUSR2 is reserved while the probe is enabled. Unset the probe variable for normal runs and never send SIGUSR2 to a probe-off process.

A single signal probes all registered, live compilers, labelled by configured name and numerical compiler ID. Completed graph counts are retained as six integers, not graph references. A compiler that is building or has never completed is skipped. Trigger only when all compilers are idle.

## JSON Lines

Each record is one appended JSON object. Compiler records carry `compiler`, `compiler_id`, `build_index` (1-based), and `epoch_ms` (Unix milliseconds).

- `build_done`: automatic snapshot immediately before each Rust compiler done hook. Non-destructive. O(1) graph/map lengths and fixed counters, no entry walks.
- `incremental_log`: the compilation's `rspack.incremental.*` logger name and text (Rust Debug representation). Collection requires no stats or infrastructureLogging switch.
- `snapshot_cost`: total automatic snapshot plus incremental-log write time, microseconds.
- `end_start`: process-wide live heap before probing any compiler.
- `end_snapshot`: non-destructive full snapshot, including owner walks and JSON interner strong counts.
- `drop`: `owner`, `before_bytes`, `after_bytes`, signed `delta_bytes = before - after`, and `elapsed_us`. Order: memory tier by cache user, then other, turbo caches, FileSystemInfo maps, resolver lock maps.
- `end_remainder`: live heap and counts after that compiler's drops.
- `end_complete`: process-wide remaining live heap and total END `elapsed_us`.
- `end_skipped`: no completed snapshot, typically because a compiler is still building.

### Fields

- `live_bytes`: flushed Rust global-allocator requested bytes. Excludes V8, other native allocators, mimalloc bookkeeping, and freed pages. Only the calling thread's pending batch is flushed. Other threads retain less than 256 KiB each; regard small signed deltas and accounting drift within this resolution as noise.
- `rss_anon_bytes`: Linux `/proc/self/status` RssAnon in bytes, process-wide.
- `graph`: `[modules, dependencies, connections, async_blocks, chunks, codegen_module_entries]`. Counts are exact for the last completed compilation. Codegen counts module keys, not per-runtime duplicates.
- `cache.tier_entries`: total shared memory-tier entries, including known misses.
- `cache.tier_users`: END-only counts belonging to this compiler's namespace in user order below; null at build-done.
- `cache.file.pending_writes`: entries staged for persistence; never dropped.
- `cache.file.block_caches`: `[[key_entry_count, key_weight_bytes], [value_entry_count, value_weight_bytes]]`. The accessor reads existing quick_cache instances and never initializes them. Turbo `clear_cache` also clears mapped SST metadata caches.
- `cache.file.filesystem_info` and `filesystem_info`: `[path_classification, file_timestamps, file_hashes, file_timestamp_hashes, context_timestamps, context_hashes, context_timestamp_hashes, managed_items, managed_item_directory_info]`. The former belongs to filesystem-cache validation; the latter to the compilation. Both are included in the FileSystemInfo drop delta.
- `resolver_locks`: total entry count of live root and child resolver lock maps. The registry contains weak handles only.
- `json_interner`: `[table_length, live_strong_count]`. The second is null at build-done and populated only at END. Process-wide, not additive across compilers.
- `cache_counters`: one `[memory_hit, pending_write_hit, database_hit, miss, store]` row per user, reset at each compiler build/rebuild start. Relaxed atomics count actual new-cache lookups and stores, not unique keys or all artifact reads.
- User order: `resolver`, `loader`, `code_generation`, `runtime_requirements`, `js_render`, `css_render`, `extract_css_render`, `other`. `Compilation/modules` and metadata belong to other. This base stores runtime requirements and chunk render values in incremental artifacts, so those four new-cache user counters and tier owners are zero by construction. Code generation uses `Compilation/codeGeneration`.
- `probe_construct_us`: time building a snapshot JSON value including map lengths/END walks, before output writing.
- `probe_transient_live_bytes`: net live allocation for constructing that snapshot JSON object, not total allocation traffic. It includes concurrent allocation noise. Serialization streams directly to the log file, with no whole-line String buffer.

Live heap and RSS are process-wide. Per-compiler graph/cache counts are labelled; shared database/tier lengths may appear for more than one compiler and must not be summed. Drop deltas attribute only what is actually released. Values referenced by graphs or pending writes remain in the remainder. Weak JSON metadata is not pruned by this probe.

## Cost and validation

Automatic snapshots read fixed-size counters, fixed shard counts and small registries, allocate one small JSON object, and write incremental logs. END walks the memory tier once for counts and once per owner for retain, walks the JSON weak table, then destructively clears caches. Its latency is intentionally not representative of server timing. Per-record cost and net transient allocation fields are included; pack validation supplies measured values.

Validation uses only a public synthetic fixture, with one excluded NEW and LEG warm launch each, one real source edit and restore, at least 65 seconds idle, END, then teardown. Probe-off parity and absence of the thread are separately checked. The shared fixture is never modified: validation makes a timestamp-preserving copy. No application data is included in the branch or pack.

No JavaScript changes: the core and binding wrapper tgz files are copied byte-for-byte from the base pack. Only the GNU native artifact and its tgz change. A local copy of rspack-turbo-persistence 0.1.1 exposes non-initializing block-cache count/weight reads; no `stats` feature is enabled. Legacy storage exposes no accessible in-memory cache-only clear, so LEG performs snapshots only, without destructive drop steps.

### Measured public-synthetic cost (n=1, Linux x64)

NEW automatic snapshot plus incremental-log writes: 0.587 / 0.801 / 0.920 ms for warm initial build, edit, restore. Snapshot construction: 0.128 / 0.195 / 0.236 ms; net transient JSON allocation: 8,285 bytes each. LEG: 0.403 / 0.570 / 0.664 ms total and 6,410 bytes per snapshot. These are probe costs, not application timing results or total allocation traffic.

NEW END: 1.009 seconds total, including 108 ms for the full non-destructive tier walk and 638 ms dropping resolver entries. END snapshot net transient allocation: 8,863 bytes. LEG END: 1.058 ms total, with no destructive steps. The owner-probe thread consumed zero CPU ticks during each 65-second pre-trigger idle window; its configured stack is 256 KiB of virtual address space. Registry/counter/weak-handle overhead is small but not separately byte-profiled. No graph or decoded values are cloned for measurement.

The memory tier released 268.038 MiB of resolver values, 16.830 MiB of code-generation references and 14.108 MiB of other references. Turbo block weight was non-zero at initial build-done (336.403 MiB) and zero at END after idle. NEW drop sum plus remainder matched pre-drop live heap within 1 byte. Existing retained tier table capacity and database metadata are intentionally left in the remainder. Counts and deltas are not estimates of another workload's memory.

Core and binding-wrapper tarballs are byte-identical to abpe3. Enabled NEW/LEG warm launch, one edit and restore, output parity for every stage against probe-off and abpe3, no probe-off thread, incremental log collection without a debug/stats switch, and MultiCompiler client/server labels all passed. No feature/performance claim is made.
