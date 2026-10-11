# NEXT-MAX-T diagnostic release pack

Commit: @COMMIT@
Base: NEXT-MAX 8aefea23a929df4c500562739b7b994966195108.
Linux x64 glibc only. Bench-only native SplitChunks diagnostics; not an official release. All three packages retain version 2.2.8 and must be installed together from this pack, not mixed with published packages.

## Install

From the application directory, replace PACK with the absolute pack directory:

```sh
cd "$PACK" && sha256sum -c SHA256SUMS
# Return to the application directory:
pnpm add --save-exact "$PACK/rspack-core-2.2.8.tgz" "$PACK/rspack-binding-2.2.8.tgz" "$PACK/rspack-binding-linux-x64-gnu-2.2.8.tgz"
```

For a workspace that already pins Rspack transitively, override all three packages at the workspace root to these absolute `file:` tarball paths, then reinstall. Confirm the consumer resolves this core/binding, not another nested copy. The standalone `rspack.linux-x64-gnu.node` is byte-identical to the GNU package payload. Optional explicit selection:

```sh
export NAPI_RS_NATIVE_LIBRARY_PATH="$PACK/rspack.linux-x64-gnu.node"
```

Optional NEXT-MAX spin configuration, applied before launching Node:

```sh
unset RSPACK_RAYON_SPIN_US
export RSPACK_RAYON_SPIN_ROUNDS=2048
export RSPACK_RAYON_SPIN_MODE=yield
# Launch your usual app command once.
```

Unset spin variables preserve the original default. Rounds accepts unsigned 32-bit integers below 4294967295 (zero valid); invalid values are ignored. SPIN_US, if valid, overrides rounds. Settings are process-wide and read once when the first Rayon pool is built.

## Read native diagnostics

Use the Stats object returned by the normal compilation callback or existing done observer. The binding installs no JS hook taps or infrastructure-log forwarding.

```js
const { logging } = stats.toJson({
  all: false,
  logging: 'verbose',
  loggingDebug: [/SplitChunks/],
});
for (const [name, group] of Object.entries(logging ?? {})) {
  if (!name.startsWith('rspack.SplitChunksPlugin')) continue;
  for (const entry of group.entries ?? []) console.log(name, entry.type, entry.message);
}
```

Alternatively configure `stats: { all: false, logging: 'verbose', loggingDebug: [/SplitChunks/] }` and print `stats.toString()` with those options. `infrastructureLogging` alone does not expose these compilation logger entries.

Read `rspack.SplitChunksPlugin` for one summed line per timer per invocation. Time entries have messages `LABEL: N ms`. Read child loggers `rspack.SplitChunksPlugin/priority NUMBER` for detail on at most 10 levels, ranked by `stage0 priority total` wall time (descending; ties by descending priority). Labels contain only numeric priorities, never cache-group names. The `stage0 priority levels` log gives total levels and number shown. Child details are included in parent sums; never add them again.

| Exact timer label | Meaning |
| --- | --- |
| `prepare module data` | Initial module/chunk/size preparation. |
| `prepare cache groups` | Sort and group cache groups by priority. |
| `process cache groups` | Authoritative wall time for native precompute and the whole priority loop. |
| `ensure max size fit` | Final maximum-size enforcement outside process groups. |
| `stage0 native precompute` | #25's shared native membership precompute across eligible priorities, including job/bitset setup and normalization. Not assigned artificially to individual levels. |
| `stage0 priority total` | Priority-loop wall time, summed across levels; includes edge cleanup and all priority work, excludes shared precompute. |
| `stage0 combinator` | Build chunk combination tables for each priority. |
| `stage0 matching total` | Entire candidate map preparation. |
| `stage0 matching native` | Native candidate matching/assembly dispatch, including precomputed membership lookup; concurrent Rayon work is measured by its wall envelope. |
| `stage0 matching JS-bearing` | Callback-bearing group preparation, including JS phases and native work in that path. |
| `stage0 matching assembly` | Collect, sort and assemble the final candidate map. |
| `stage0 candidate initial sizes` | Prepare sizes/comparator inputs and apply initial minimum-size pruning. |
| `stage0 candidate selection` | Sampled aggregate estimate of best-candidate selection. |
| `stage0 candidate updates` | Sampled aggregate estimate of competing-candidate cleanup after winners. |
| `stage0 split application` | Sampled aggregate estimate of winner application/checks, excluding candidate updates and deferred edge bookkeeping. |
| `stage0 JS test phase` | Batched/scalar callback test phase wall spans, including transport, suspension and result handling. |
| `stage0 JS chunks phase` | Callback chunk-selection phase wall spans. |
| `stage0 JS name phase` | Callback name-selection phase wall spans. |
| `stage0 native test phase` | Native test work in callback-bearing group rounds. |
| `stage0 native name phase` | Native name work in callback-bearing group rounds. |
| `stage0 name_for_condition sampled` | Raw summed sampled resource-name call duration; multiply by 1024 for aggregate CPU estimate. Includes shared lazy name computation once per module in precompute; that shared part is parent-only. |
| `stage0 native matcher sampled CPU` | Raw summed sampled native matcher duration; multiply by 1024 for aggregate CPU estimate. Fallback includes name lookup; precompute excludes its shared name lookup. |

Zero-valued phase lines are emitted when that phase is unused. `stage0 name_for_condition samples` also reports native matcher sample count. Resource-name/matcher calls are sampled deterministically by module identifier hash, 1/1024, without clock reads or atomic increments on unsampled calls. Candidate selection/updates/application sample one in 16 candidate rounds and already scale by 16; do not multiply those lines again. These candidate estimates can be zero for a phase with no sampled executed round and noisy for small levels. All counters are invocation-local, not retained across builds.

**Sampled values are aggregate CPU estimates, not wall time.** Deterministic samples, nested timer overhead and scheduling pauses can bias extrapolation. Parallel CPU estimates may exceed parent wall time. Phase parents and children overlap; JS spans include suspension, not just JS body CPU. Do not sum every line, subtract sampled CPU from wall time, or infer native share by subtracting overlapping awaits. Shared precompute is outside priority totals. Treat `process cache groups` as the wall-time reference and the phase hierarchy/samples as diagnostic attribution.

Release build: explicit `RUST_TARGET=x86_64-unknown-linux-gnu`, release profile, no default features, `plugin,info-level`, `-Zlocation-detail=none -Cforce-unwind-tables=no -Zbuild-std=panic_abort,std`. Matching JS and native packages are built from the commit above. Verification evidence accompanies the pack artifact separately.
