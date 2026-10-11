# Rejected idle-release probes

These fork-only patches apply to `3d527a9b5a026d7e9ea6e20a4d2ca1157fb6f0ca`. They are experiments, not production-ready APIs. They use direct mimalloc FFI and do not guard alternate allocators. No allocator environment settings are changed.

- `collect-idle.patch`: clear on BeginIdle, then force collection on the idle thread. Linux post-close memory and first-rebuild time failed.
- `collect-owners.patch`: additionally force collection on each Rayon worker. The matched Linux run passed anonymous memory but failed first-rebuild time.
- `collect-owners-after-idle.patch`: move clear and owner collection after completed idle work. Linux fixed-offset memory and lifetime peak failed.

The existing observation patch still applies to each variant. Optional Linux smaps logging used for attribution is deliberately excluded. Build both arms with `RUST_TARGET=x86_64-unknown-linux-gnu` on Linux to match release unwind-table flags. All arms must restore copies of one closed baseline seed with preserved timestamps. The runner keeps development incremental defaults.

Five paired comparisons plus five A/A controls were measured per Linux variant. macOS and Windows measured unchanged B1 with a shared seed, not these rejected variants. No cross-platform pass is claimed. Measurement is disabled on the branch after rejection.
