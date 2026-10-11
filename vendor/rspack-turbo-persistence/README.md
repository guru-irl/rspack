# rspack-turbo-persistence

This crate is a temporary distribution of Vercel's `turbo-persistence`,
published by the [Rspack](https://github.com/web-infra-dev/rspack) project
solely for Rspack's internal use.

It is not an official Vercel or Next.js release and is not intended for use
as a general-purpose dependency. No stability or compatibility guarantees
are provided outside Rspack.

The Rust source is taken from the
[Next.js repository](https://github.com/vercel/next.js). The exact upstream
revision is pinned by this repository's `upstream/next.js` submodule.
Repository-owned patches from `patches/` are applied to a generated source
copy, leaving the submodule unchanged.

Rspack will migrate to the official upstream crate and deprecate this package
when an official release becomes available.

## Development

After cloning, initialize the submodule and generate the patched source copy:

```sh
git submodule update --init
node scripts/cli.js
```

The CLI creates the package files ignored by Git: generated links, a patched
copy of the upstream `src/` directory, `Cargo.toml`, and `Cargo.lock`. It never
modifies the submodule. To verify that the generated links, patched source, and
manifest are up to date, run:

```sh
node scripts/cli.js --check
```

## Publishing

1. Update the `upstream/next.js` submodule and files in `patches/` if needed.
2. Update the version in `VERSION`. Do not edit the generated `Cargo.toml` or
   `Cargo.lock` directly.
3. Generate and test the package:

   ```sh
   git submodule update --init
   node scripts/cli.js
   node scripts/cli.js --check
   cargo check --locked
   cargo package --locked --allow-dirty
   ```

4. Commit and push the submodule revision, patches, version change, and any
   other tracked changes.
5. Open **GitHub → Actions → Publish → Run workflow**.
6. Select the branch containing the release commit, set `push_tags`, and run
   the workflow.
7. Verify the new version on crates.io and, when `push_tags` is enabled, verify
   the matching `v<package-version>` Git tag.

If crates.io publication succeeds but tag creation fails, push the matching tag
manually instead of rerunning the workflow.
