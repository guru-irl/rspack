# Stable absence code-splitting cache pack

This pack adds an opt-in rule to the code-splitting cache diagnostic pack.

## Flags

- `RSPACK_CODE_SPLITTING_CACHE_STABLE_ABSENCE=1` enables stable absence. Only the exact value `1` enables it. The process reads it once, so restart after changing it.
- `RSPACK_CODE_SPLITTING_CACHE_DEBUG=1` enables detailed cache diagnostics. It is independent of stable absence.
- `RSPACK_SPLIT_CHUNKS_REPLAY=1` enables SplitChunks replay. `force` also enables replay for configurations that do not opt in through their options.

With stable absence unset, control flow and logs match the diagnostic pack. With the debug flag also unset, behavior matches SW. The wrapper and core archives are unchanged from SW. Only the GNU native binding and its archive are new.

## Rule

After the existing block, nested-block, group-option and connection checks, a module without a cached root can pass only when stable absence is enabled, it has no module-add or module-update mutation in this compilation, no cached runtime contains its module block, and the recovered chunk graph places it in zero chunks.

The recovered graph is the previous compilation's snapshot taken immediately after code splitting, before later chunk optimization. The current pass checks it before resetting or rebuilding it.

The module was unreachable and was not rebuilt, so its own analysis is unchanged. It can enter a chunk only if a reachable module changes its connection to it. Reachable affected modules still receive the full check. A module previously in a chunk never qualifies.

## Debug lines

An acceptance is logged as `debug: module=<id>, accepted: stable absence`. With stable absence enabled, the summary adds `absent-accepted <n>`. Other failures keep the existing reason lines and the first `module topology change detected` line. With stable absence unset, the summary format is unchanged.

## Validation

The workflow runs the watch suites with the flag unset, then with stable absence enabled and replay forced. Both runs must have exactly the same six known release-profile loader-cache failures. The focused watch case must pass with the flag on and fail specifically at step 1 with it off. Its later steps make the unused hook reachable and update its constant again.

The pinned public fixture is compared with stable absence on and off, with replay and diagnostics enabled in both arms. Every emitted filename and byte must match after cold build, content edit, module addition with dynamic import, and a final content edit. Native identity is checked from `/proc/self/maps` and SHA-256 in the test workers and fixture processes.

Check all delivered files with `sha256sum -c SHA256SUMS` before use. Keep the native binding, GNU archive, wrapper and core archive together. Existing watchpack reuse behavior comes from the unchanged SW core archive.
