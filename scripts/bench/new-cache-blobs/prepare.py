"""Prepare independent sources outside the Rspack workspace and Cargo config."""

import hashlib
import os
from pathlib import Path
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
WORK = Path(os.environ["GITHUB_WORKSPACE"]).parent / ".spider/scratch/new-cache-blobs"
WORK.mkdir(parents=True, exist_ok=True)
archive = WORK / "rspack-turbo-persistence-0.1.1.crate"
urllib.request.urlretrieve(
    "https://static.crates.io/crates/rspack-turbo-persistence/"
    "rspack-turbo-persistence-0.1.1.crate",
    archive,
)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == (
    "be5bb8d1b648815f264b0503bbfdb6b763e8011f6636d45418c5446f7538635d"
)
with tarfile.open(archive) as package:
    package.extractall(WORK / "published", filter="data")

published = WORK / "published/rspack-turbo-persistence-0.1.1"
vendor = ROOT / "vendor/rspack-turbo-persistence"
shutil.copytree(published, WORK / "baseline-crate")
shutil.copytree(vendor, WORK / "patched-crate")
# Only the new regression is copied into the baseline crate. Production stays pristine.
tests = (vendor / "src/tests.rs").read_text()
start = tests.index("#[test]\nfn commit_deletes_superseded_blob()")
end = tests.index("\n#[test]", start + 1)
regression = tests[start:end]
base_tests = WORK / "baseline-crate/src/tests.rs"
base_tests.write_text(base_tests.read_text() + "\n" + regression + "\n")

for variant in ("baseline", "patched"):
    harness = WORK / variant
    shutil.copytree(ROOT / "scripts/bench/new-cache-blobs/src", harness / "src")
    manifest = (ROOT / "scripts/bench/new-cache-blobs/Cargo.toml").read_text()
    if variant == "patched":
        manifest += (
            '\n[patch.crates-io]\n'
            'rspack-turbo-persistence = { path = "../patched-crate" }\n'
        )
    (harness / "Cargo.toml").write_text(manifest)
    lock = (ROOT / "scripts/bench/new-cache-blobs/Cargo.lock").read_text()
    if variant == "patched":
        start = lock.index('name = "rspack-turbo-persistence"')
        end = lock.index("\n[[package]]", start)
        lines = lock[start:end].splitlines(keepends=True)
        entry = "".join(
            line for line in lines
            if not line.startswith(("source = ", "checksum = "))
        )
        lock = lock[:start] + entry + lock[end:]
    (harness / "Cargo.lock").write_text(lock)
(WORK / "out").mkdir(exist_ok=True)
print(f"Prepared baseline and patched sources under {WORK}")
