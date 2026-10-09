# TanStack reference-filter benchmark

This synthetic React app uses 200 file-based routes, one root route, and 20,000 distinct `.ts`/`.tsx` data modules imported by those routes. Route components are automatically code-split. Each route has a local binding used by its loader and component, exercising shared virtual modules too.

Published dependencies include `@rspack/core@2.2.8`, `@tanstack/router-plugin@1.168.42`, React 19.2.0 and Vite 7.3.1. The resolved router and unplugin versions and the npm dependency tree are included in the results artifact. Vite is used for a separate semantics diagnostic, not for timing.

Arms patch only the published router-plugin reference-transform ID filter:

- S: stock `exclude: [tsrSplit, tsrShared]`.
- R: query-anchored `exclude: [/[?&]tsr-split(?:[=&]|$)/, /[?&]tsr-shared(?:[=&]|$)/]`.
- N: no excludes.

There are five rounds, with arm orders S/R/N, R/N/S, N/S/R, S/R/N, R/N/S. Each arm runs a cold sample and a warm sample in separate fresh processes. Cold builds disable the compiler cache. Warm samples start a fresh watch compiler with memory caching, complete an unmeasured baseline build, then edit one data module and measure the rebuild. No persisted compiler cache is used. This is not a cold filesystem-cache benchmark.

Wall and process CPU cover `compiler.run()` through its callback for cold builds and `watchRun` through its callback for warm rebuilds. CPU uses `process.cpuUsage()`, including native threads. The make interval runs from an early `make` tap to a late `finishMake` tap. Warm wall time excludes the file-watch debounce before `watchRun`.

A parent process samples the compiler process's Linux `RssAnon` every 10 ms during each measured phase and reads it again at the callback while the compilation remains live. Peak and end values exclude the monitor. They are anonymous resident memory, not total RSS, heap size, or post-idle memory. Warm monitoring begins immediately before the edit, so it also covers the debounce interval.

An excluded diagnostic patches the published unplugin adapter to observe reference-rule calls and the loader's full transform-filter calls. The adapter is restored before any timed samples. A Vite diagnostic observes pre-transform IDs and evaluates the published Vite hook-filter implementation. SHA-256 manifests compare every emitted filename and byte across all arms and repetitions separately for cold and warm outputs.

The results contain individual samples, arm medians, medians of within-round deltas and percentage changes, and exact two-sided signed-rank p values computed by enumerating all sign assignments. With five nonzero pairs the smallest possible two-sided p value is 0.0625. There is no multiple-comparison adjustment.

To reproduce on Linux with Node 22:

```sh
node scripts/bench-tanstack-filter/generate.mjs
cd benchmark-app
npm install --registry=https://registry.npmjs.org --ignore-scripts
node ../scripts/bench-tanstack-filter/run.mjs
```
