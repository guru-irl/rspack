import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
pre = json.loads((root / 'pre-compaction-census.json').read_text())
post = json.loads((root / 'post-compaction-census.json').read_text())
capture = json.loads((root / 'capture.json').read_text())
build = json.loads((root / 'build.json').read_text())
assert pre['duplicate_physical_keys'] == post['duplicate_physical_keys'] == 0
assert pre['content_crc_sum'] == post['content_crc_sum']
assert pre['physical_families']['0']['entries'] == post['physical_families']['0']['entries']
assert build['version'] == '2.2.8'
assert build['modules'] >= 60000
MIB = 1048576
TARGET = 300 * MIB

def mib(n): return f'{n / MIB:,.3f}'
def ratio(a, b): return f'{a / b:.4f}' if b else 'n/a'
def demand(b): return b['compressed_raw_bytes'] + 8 * b['compressed']

print('# New-cache SST census\n')
print('## Setup and capture\n')
print('Public 60,000-JS-module parity generator, copied unchanged from `bench/newcache-parity` at `58bca77c02810995b072ab952209fe5f34a8af93`. Ten modules per directory, three forward imports, CSS every fifth module, two of twenty synthetic packages per module, large package metadata, and a trivial JS loader. Development mode, no source maps, `experiments.newCache: true`, filesystem cache. No codec or capacity change.\n')
print(f'Published npm `@rspack/core` and `@rspack/cli` 2.2.8; build reports **{build["modules"]:,} compiled modules**. Harness branch is based on upstream `f2903b6482cb7a0fcdca912d23062bd94d3d5636`; the measured binding is the published npm binary, not a source build at that commit. GitHub-hosted `ubuntu-24.04` only. Environment and hashes are in the artifact.\n')
print(f'First-store copy: intercepted the successful nonzero `CURRENT` rename, stopped every process thread with SIGSTOP, then copied before resuming. Committed sequence **{capture["first_store_sequence"]}**; pre-copy log has **{capture["pre_log_compactions"]} compactions**. Post-copy follows 30 seconds idle and successful compiler close, sequence **{capture["post_compaction_sequence"]}**, **{capture["post_log_compactions"]} logged merge segments**. Close waits for background work; actual compaction and a newer committed sequence are required.\n')
print('Built the unmodified published `rspack-turbo-persistence` 0.1.1 `sst_inspect` binary with Cargo, crate only. Raw output is retained. Its family names are hardcoded for Turbopack and its “Value blocks” combines small and medium blocks. A separate diagnostic binary appended to a scratch copy uses the same active-meta/SstFilter and checksummed block reader, then follows the key references to distinguish them. No registry or production source was patched.\n')
print('## Headline\n')
print('| Copy | Small payload, all blocks (MiB) | Compressed-small full-restore demand, incl. cache weight (MiB) | Demand / 300 MiB | Framed per-value residual demand (MiB) | Blocks going raw | Capped cache-weight saving estimate (MiB) |')
print('|---|---:|---:|---:|---:|---:|---:|')
for label, data in [('Before compaction', pre), ('After compaction', post)]:
    b = data['blocks']['small']
    sim = data['simulation']['framed8_repacked']['blocks']
    old, new = demand(b), demand(sim)
    saving = min(old, TARGET) - min(new, TARGET)
    print(f'| {label} | {mib(b["raw_payload_bytes"])} | {mib(old)} | {ratio(old,TARGET)} | {mib(new)} | {sim["uncompressed"]:,}/{sim["count"]:,} ({100*sim["uncompressed"]/sim["count"]:.2f}%) | {mib(saving)} |')
print('\nDemand is the sum of **decompressed compressed-small blocks**, counted once per block, plus the crate weighter’s 8 bytes/block. Raw small blocks bypass the anonymous BlockCache. “All blocks” includes both raw and compressed payload. Full database restore is an offline demand census, not an observed warm-build access count or eviction/hit-rate trace. The target is an eviction target, not a strict process-memory bound.\n')
print('The capped estimate is `min(D_before, 300 MiB) - min(D_codec, 300 MiB)`, not `294 MiB - D_codec`. It is a conditional reduction in anonymous cache weight during dense restore, **not a measured total RSS or lifetime peak saving**. Decoded objects and key blocks remain; pins, cache shard utilization, allocator reservation, added mapped bytes and access order are excluded. Idle compaction already clears the cache, so there is no predicted normal-END live-block saving.\n')
for label, data in [('Before compaction', pre), ('After compaction', post)]:
    print(f'## {label}\n')
    print('### Physical families\n')
    print('| Family ID | Rspack name | Physical entries | SST files |')
    print('|---:|---|---:|---:|')
    for family, row in data['physical_families'].items():
        print(f'| {family} | {row["name"]} | {row["entries"]:,} | {row["sst_files"]:,} |')
    print('\nZero duplicate physical keys in either copy; equal entry totals and aggregate decoded-value CRC sums before/after compaction. These are physical entries, not “restored modules”.\n')
    print('### Blocks and compression\n')
    print('| Type | Blocks | Compressed / raw count | Stored payload (MiB) | Uncompressed payload (MiB) | Stored/raw ratio | Compressed-block raw bytes (MiB) | Raw-block bytes (MiB) |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|')
    for kind, b in data['blocks'].items():
        print(f'| {kind} | {b["count"]:,} | {b["compressed"]:,} / {b["uncompressed"]:,} | {mib(b["stored_payload_bytes"])} | {mib(b["raw_payload_bytes"])} | {ratio(b["stored_payload_bytes"],b["raw_payload_bytes"])} | {mib(b["compressed_raw_bytes"])} | {mib(b["uncompressed_raw_bytes"])} |')
    print('\nPayload bytes exclude 8-byte on-disk block headers and the 4-byte/block directory, both included in file sizes. Medium blocks are dedicated and read uncached, not part of the 300 MiB small-value cache.\n')
    print('### Logical value families and individual LZ4 compressibility\n')
    print('| Family | Entries | Small / medium / blob / inline | Raw archives (MiB) | LZ4 payload (MiB) | LZ4/raw | Raw-fallback + 8 B framing (MiB) | Compressible values | Min/max bytes |')
    print('|---|---:|---|---:|---:|---:|---:|---:|---:|')
    for family, row in data['logical_families'].items():
        counts = ' / '.join(f'{row["classes"].get(c,[0,0])[0]:,}' for c in ['small','medium','blob','inline'])
        print(f'| {family} | {row["entries"]:,} | {counts} | {mib(row["raw_bytes"])} | {mib(row["lz4_bytes"])} | {ratio(row["lz4_bytes"],row["raw_bytes"])} | {mib(row["framed_bytes"])} | {row["compressed_values"]:,} | {row["min"]:,} / {row["max"]:,} |')
    print('\nAll values were individually compressed using existing `lzzzz::lz4`, default acceleration, rather than sampling. Every small-value compression was decoded and byte-compared. The 8 B estimate is one independent value header, no chunk dictionary, raw fallback when LZ4 is not smaller; it does not propose a production format. Namespace attribution comes from UTF-8 key components. Missing families/classes have zero entries in this fixture.\n')
    print('### Value-size histogram\n')
    print('| Family | Archive-size bucket (bytes) | Entries | Archive bytes (MiB) |')
    print('|---|---|---:|---:|')
    for family, row in data['logical_families'].items():
        for bucket, (count, size) in sorted(row['histogram'].items(), key=lambda item: int(item[0].split('..')[0].lstrip('>'))):
            print(f'| {family} | {bucket} | {count:,} | {mib(size)} |')
    print('\n### Outer-compression simulation\n')
    print('| Model | Small groups | Raw groups | Raw share | Residual compressed-group demand (MiB) | Stored small payload (MiB) | Framing-promoted values |')
    print('|---|---:|---:|---:|---:|---:|---:|')
    for model, row in data['simulation'].items():
        b = row['blocks']
        print(f'| {model} | {b["count"]:,} | {b["uncompressed"]:,} | {100*b["uncompressed"]/b["count"]:.2f}% | {mib(demand(b))} | {mib(b["stored_payload_bytes"])} | {row["promoted_values"]:,} |')
    print('\nFramed8 repacking preserves value order and SST boundaries, flushes when grouped bytes reach >=8192 B, and applies the crate’s strict `compressed < raw - floor(raw/8)` test. Original-groups resets at each original small block; payload-only is an optimistic header-free sensitivity control, not a decodable format. Originally-medium/blob values are **not** compressed into the small class. Headers moving a small value above 4096 B are reported as promotions. New SST/key overhead and the changed compaction selector behavior are not simulated.\n')
    print('### Files eligible for mmap\n')
    print(f'Active SST total: **{mib(data["active_sst_bytes"])} MiB**. Per-file sizes are in the JSON `sst_manifest`. Meta and blob files are shown below; this is mapping address-space/file size, **not measured residency**. The report does not count cache file bytes as anonymous RAM.\n')
    print('| Extension | Files on disk | Logical size (MiB) |')
    print('|---|---:|---:|')
    for ext, (count, size) in data['files_by_extension'].items():
        print(f'| {ext} | {count:,} | {mib(size)} |')
print('\n## Gate outcome and limits\n')
b = post['blocks']['small']
sim = post['simulation']['framed8_repacked']['blocks']
saving = min(demand(b), TARGET) - min(demand(sim), TARGET)
print(f'Post-compaction full-restore compressed-small demand is **{mib(demand(b))} MiB**, versus the **300 MiB** target. Independent-value LZ4 with 8 B framing makes **{100*sim["uncompressed"]/sim["count"]:.2f}%** of repacked small blocks raw and leaves **{mib(demand(sim))} MiB** residual demand. The capped anonymous-cache estimate is **{mib(saving)} MiB** saving.\n')
print('This resolves the offline M4 inputs for this public fixture only. It does not establish an actual peak saving, acceptable CPU cost, cross-platform nonincrease, or a capacity value. Codec/capacity changes still require paired live measurements. Original and candidate disk payload ratios, compression residuals and compaction copies are available; compression cannot be judged just from individual-value ratios.\n')
print('## Reproduction and evidence\n')
print('Workflow: `.github/workflows/newcache-sst-census.yml`; scripts: `scripts/newcache-sst-census/`. Artifact retains both database copies, unmodified `sst_inspect --verbose` outputs, exact census JSON, file SHA-256 manifests, capture provenance, npm/binding/crate/tool hashes, environment, build count and infrastructure events.\n')
