# Code-splitting cache diagnostic pack

This is the SW pack (v2.2.9-hot with SplitChunks replay and Watchpack reuse) plus native debug logging only. The core archive and JavaScript binding wrapper are unchanged. The core archive SHA-256 is `bbe897e6cd0ae6a5d670ad0629fcd62166a59aa25954d796539030b2775e7c83`.

## Enable and capture

Set `RSPACK_CODE_SPLITTING_CACHE_DEBUG=1` before starting the process. The native flag is read once; other values do not enable it. With the flag unset, the topology checks retain their normal early-exit behavior and log output. The flag does not change the reuse decision.

These are **compilation logger** entries under `rspack.Compilation.codeSplittingCache`, at `log` level. They are not infrastructure logger entries: `compiler.hooks.infrastructureLog` does not capture this channel.

For printed stats, set `stats: { logging: 'log' }`. For programmatic capture in the watch callback:

```js
const json = stats.toJson({ all: false, logging: 'log' });
for (const entry of json.logging?.['rspack.Compilation.codeSplittingCache']?.entries || []) {
  console.log(entry.message);
}
```

Keep the SW flags, including `RSPACK_SPLIT_CHUNKS_REPLAY=1` and any Watchpack reuse setting, as before. This new flag only controls native topology diagnostics.

## Lines and reasons

Every diagnostic line starts with `debug:`. When topology validation runs, one summary reports the affected count, failing count, and up to 20 rebuilt module identifiers. `more` counts omitted rebuilt identifiers. Rebuilt means a `ModuleUpdate` or `ModuleAdd` mutation in this compilation's build-module-graph pass, not merely an affected importer.

Up to 30 failing affected modules are logged, each with its identifier, rebuilt status and first failing check. All affected modules are checked when debugging is enabled, even after the first failure. The usual first topology-change message remains.

- `blocks`: direct async block identifiers differ. Cached and current counts and their first five IDs are shown.
- `nested-block`: a current async block has nested children, or its cached prepared entry had children. The conservative reuse check does not recursively validate those blocks.
- `group options`: the async block's cached and current group options differ. Both are printed in Rust Debug form.
- `missing cached block`: the runtime map contains the module root but lacks a required block. The runtime and block are shown.
- `count`: the cached and current connection-group counts differ. Each list shows up to 40 `(target module, state)` entries, with its full count.
- `module mismatch`: the target module at a connection-group index differs. The runtime, block, index and both targets are shown.
- `state`: a group's merged connection activity differs. The runtime, block, index, target and cached/current states are shown, followed by the target's current evaluation-side-effects state and every dependency's type, ID and own current activity.
- `not-cached root`: no reusable cached root was found, including the existing conservative rules for connectionless modules. The line also says whether any runtime map contains the module block.

Entrypoint changes, disabled incremental build-module-graph processing, module removal and an empty cache retain their existing messages and return before topology diagnostics. A cold build therefore need not produce a summary.

Diagnostics may contain full module paths and dependency metadata. They are intended for local troubleshooting; review logs before sharing them. Diagnostic mode performs extra evaluation and formatting. No performance or memory claim is made for that mode.

## Payload and checks

Install the GNU binding archive and wrapper with the unchanged SW core archive. The bare `.node` is included for direct replacement. `SHA256SUMS` covers the README and all payloads; verify it before use with `sha256sum -c SHA256SUMS`.

The build uses the replay pack's official Linux GNU release profile and pinned toolchain. Validation includes the normal watch pass with the flag unset, a three-step public development watch fixture (cold, content edit, added module plus dynamic import), and emitted filename-and-byte parity between debug-enabled and unset processes. The native file loaded by those processes is checked through `/proc/self/maps` and SHA-256.

The release profile omits test-only built-in loaders. Its six known watch failures are the cold contexts of `loaders/loader-cache` and `loaders/loader-cache-content-type`, each in the regular, incremental and native-watcher runners. The validation gate rejects additional failures. Only Linux x64 GNU is built. The fixture requires at least one topology failure reason; it does not independently force every reason.
