# Vendored rspack-turbo-persistence

This directory contains the published `rspack-turbo-persistence` 0.1.1 crate,
with `patches/delete-superseded-blobs.patch` applied to `src/`.
The MIT license and Vercel copyright notice are retained in `LICENSE`.

## Provenance

- Package: https://crates.io/crates/rspack-turbo-persistence/0.1.1
- Archive SHA-256: `be5bb8d1b648815f264b0503bbfdb6b763e8011f6636d45418c5446f7538635d`
- Distribution repository: https://github.com/ahabhgk/rspack-turbo-persistence
- Distribution revision inspected: `88e3da700d9507f679a50f63305c59d2cbebe38a`
- Next.js source revision: `f3edea1b06730ce507aeb1b10c8e4f652ca5540d`

The distribution generates its manifest and source from the pinned Next.js
submodule and applies its own `patches/`, including 32-bit support. Its Git
repository does not directly contain a consumable crate. This copy uses the
published archive, so those distribution changes are already included.
`Cargo.toml.orig` and `README.md` are retained as published; generated lockfiles
and registry bookkeeping are omitted.

## Local patch

Incoming SingleValue blob puts retire the visible preceding blob through the
existing durable deletion path. Lookup reads key metadata, not value contents.
The format and compaction behavior are unchanged. Blob-to-non-blob overwrites,
explicit deletes, MultiValue blobs and pre-existing orphan blobs still depend
on compaction. Independent read-only processes retain the existing deletion
race, now also after blob replacement commits. Deletion records are cleaned
on reopening. Windows unlink failures use the existing deferred retry path.

The patch includes one regression test and preserves the existing crate tests.
CI runs the standalone crate suite on Linux, macOS and Windows. The crate is
excluded from Rspack's workspace so third-party code retains its own manifest
and does not inherit Rspack's formatting or lint policies.

This fix belongs in the distribution repository's `patches/` directory when
upstreamed. Once a corrected crate is published, remove this directory and the
root `[patch.crates-io]` entry and update the dependency and lockfile.
