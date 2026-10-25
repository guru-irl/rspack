# Stable absence code-splitting cache pack

This pack adds an opt-in rule to the code-splitting cache diagnostic pack.

## Flags

- `RSPACK_CODE_SPLITTING_CACHE_STABLE_ABSENCE=1` enables stable absence. Only the exact value `1` enables it. The process reads it once, so restart after changing it.
- `RSPACK_CODE_SPLITTING_CACHE_DEBUG=1` enables detailed cache diagnostics. It is independent of stable absence.
- `RSPACK_SPLIT_CHUNKS_REPLAY=1` enables SplitChunks replay. `force` also enables replay for configurations that do not opt in through their options.

With stable absence unset, control flow and logs match the diagnostic pack. With the debug flag also unset, behavior matches SW. The wrapper and core archives are unchanged from SW. Only the GNU native binding and its archive are new.

## Rule

The rule applies only when `optimization.sideEffects` is not the analysed `true` mode and `optimization.usedExports` is disabled. Development defaults meet these conditions.

After the existing block, nested-block, group-option and connection checks, a module without a cached root can pass only when stable absence is enabled under those options, it has no module-add or module-update mutation in this compilation, no cached runtime contains its module block, and the recovered chunk graph places it in zero chunks.

The recovered graph is the previous compilation's snapshot taken immediately after code splitting, before later chunk optimization. The current pass checks it before resetting or rebuilding it.

In side-effect flag mode or disabled mode, side-effect state comes only from the module's factory metadata. It is local to the module. With used-exports disabled, usage changes cannot flip connection states. An unreachable module that was not rebuilt can therefore become reachable only through an edge change on a module in the affected set, whose full check compares that edge. A module previously in a chunk never qualifies.

Analysed side-effect mode can change an unbuilt importer's state when one of its dependencies gains a side effect. The rule is disabled in that mode. It is also disabled whenever used-exports is enabled.

## Debug lines

An acceptance is logged as `debug: module=<id>, accepted: stable absence`. At most 30 acceptance lines are logged per check. With the flag set, the summary adds `absent-accepted <n>`, counting all acceptances without a cap. Other failures keep the existing reason lines and the first `module topology change detected` line. With stable absence unset, the summary format is unchanged.

## Validation

The workflow runs the watch suites with the flag unset, then with stable absence enabled and replay forced. Both runs must have exactly the same six known release-profile loader-cache failures. Both focused watch cases run with the flag on and off. The barrel case must pass with the flag on and fail specifically at step 1 with it off. It checks both the topology log and verbose pass timers to prove graph reuse. Its later steps make the unused hook reachable and update its constant again.

The analysed-side-effects case must pass with the flag on and off. A dependency gains a side effect, which must execute at startup rather than wait for a later dynamic import. This case failed on the unguarded stable-absence binary before the fix.

The pinned public fixture is compared with stable absence on and off, with replay and diagnostics enabled in both arms. Every emitted filename and byte must match after cold build, content edit, module addition with dynamic import, and a final content edit. Native identity is checked from `/proc/self/maps` and SHA-256 in the test workers and fixture processes.

Check all delivered files with `sha256sum -c SHA256SUMS` before use. Keep the native binding, GNU archive, wrapper and core archive together. Existing watchpack reuse behavior comes from the unchanged SW core archive.
