# First-access cost of modules and buildInfo

This synthetic benchmark compares release 2.2.8 with the pinned published canary
`2.2.9-canary-a9cfd15e-20261009001219`. The canary commit
`a9cfd15e04efb596dac0c101b15477c402411e7c` contains shared module/buildInfo accessors
(`f93a311052`, #15883) and lazy module collection access (`53e259af9f`, #15906).
The workflow verifies ancestry and package versions before measuring. It compares
whole published builds, not an isolated measurement of either commit.

The generated project has 60,000 leaf modules, 600 grouping modules and one entry.
A loader writes one small object under `x.custom.key` for 40% of leaf modules.
A `compiler.hooks.finishMake` tap performs the first JS iteration of
`compilation.modules`, either reading that key from every module's buildInfo or
only iterating the modules. It verifies module/key counts and bundled output.

Each access mode has five samples of each binary for cold, warm newCache, warm
legacy persistent cache and one watch rebuild. The version order alternates
between samples. Warm samples use independent Node processes after a verified
seed. Warm-cache samples all precede watch edits so changed source mtimes cannot
contaminate cache-hit samples. Cache directories are separate for each binary,
backend and access mode; all runs use one fixture and output directory.

The primary wall/CPU figures cover `compiler.run` or the single watch rebuild,
through the done hook, excluding output verification. Additional whole-process
figures include imports, compiler construction, close and output verification.
Peak RssAnon is sampled every 20 ms in the build interval. End RssAnon is captured
at the done hook, before output verification. Watch whole-process figures also
include its initial compilation. Raw records retain user/sys CPU separately,
process peaks, post-close memory, output hashes, loader calls and sampling traces.

A watch edit adds a comment without changing the evaluated output. Asset hashes
must match between versions and access modes for identical inputs; the original
and watch-edited inputs are compared separately. Warm samples must execute zero
loaders; the watch rebuild must execute exactly one.

The read-minus-iteration split includes buildInfo construction, JSON conversion
and GC, not just a native getter. Supplemental canary warm CPU profiles are
collected separately and are excluded from the five measured samples.

The push-triggered `BuildInfo access benchmark` workflow runs only on the fork's
`bench/buildinfo-access` branch on `ubuntu-24.04`, using Node 22.18.0. Its artifact
contains raw records, provenance, parity checks, memory traces, profiles and
tables. It installs published packages only; it does not build repository code.
