import json
import os
from pathlib import Path
import shutil
import sys
import time

from residency import residency


def device(path):
    dev = os.stat(path).st_dev
    node = Path(f"/sys/dev/block/{os.major(dev)}:{os.minor(dev)}").resolve()
    return layers(node)


def layers(node, seen=None):
    seen = set() if seen is None else seen
    node = node.resolve()
    if str(node) in seen:
        return []
    seen.add(str(node))
    queue = node / "queue"
    if not queue.exists():
        queue = node.parent / "queue"
    row = {"device": node.name, "sysfs": str(node), "dev": (node / "dev").read_text().strip()}
    for name in ["read_ahead_kb", "max_sectors_kb", "max_hw_sectors_kb"]:
        value = queue / name
        row[name] = int(value.read_text()) if value.exists() else None
    rows = [row]
    if (node / "partition").exists():
        rows += layers(node.parent, seen)
    if (node / "slaves").exists():
        for slave in sorted((node / "slaves").iterdir()):
            rows += layers(slave, seen)
    return rows


def probe(seed, root, results):
    results.mkdir(parents=True, exist_ok=True)
    root.mkdir(parents=True, exist_ok=True)
    sources = list(seed.rglob("*.sst"))
    source = min(sources, key=lambda p: abs(p.stat().st_size - 27 * 2**20))
    target = root / "probe.sst"
    shutil.copy2(source, target)
    with target.open("rb") as f:
        os.fsync(f.fileno())
    topology = {"cache": device(root), "backing": device(Path.cwd()), "kernel": os.uname().release,
                "pageBytes": os.sysconf("SC_PAGE_SIZE"), "sourceBytes": source.stat().st_size}
    (results / "probe-sysfs.json").write_text(json.dumps(topology, indent=2))
    rows = []
    for size, sequential in [(4*2**20, False), (2**20, False), (256*1024, False), (128*1024, False), (256*1024, True)]:
        with target.open("rb") as f:
            total_bytes = target.stat().st_size
            for attempt in range(10):
                os.posix_fadvise(f.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
                cold = residency(root)
                if cold["resident"] == 0:
                    break
                time.sleep(.1)
            else:
                raise RuntimeError(f"eviction incomplete: {cold}")
            if sequential:
                os.posix_fadvise(f.fileno(), 0, 0, os.POSIX_FADV_SEQUENTIAL)
            begin = time.monotonic_ns()
            calls = 0
            for offset in range(0, total_bytes, size):
                os.posix_fadvise(f.fileno(), offset, min(size, total_bytes-offset), os.POSIX_FADV_WILLNEED)
                calls += 1
            loop_ms = (time.monotonic_ns()-begin)/1e6
            timeline = []
            began = time.monotonic()
            previous = None
            stable_since = began
            while True:
                current = residency(root)
                now = time.monotonic()
                timeline.append({"afterLoopMs": (now-began)*1000, "resident": current["resident"], "percent": current["percent"]})
                if current["resident"] != previous:
                    stable_since = now
                    previous = current["resident"]
                if now-stable_since >= .5 or now-began >= 5:
                    break
                time.sleep(.1)
            rows.append({"rangeKiB": size//1024, "sequential": sequential, "calls": calls, "loopMs": loop_ms,
                         "cold": cold, "settled": current, "timeline": timeline})
            (results / "probe-coverage.json").write_text(json.dumps(rows, indent=2))
    with target.open("rb") as f:
        while f.read(1024*1024):
            pass
    positive = residency(root)
    if positive["percent"] != 100:
        raise RuntimeError(f"positive control incomplete: {positive}")
    (results / "probe-positive.json").write_text(json.dumps(positive, indent=2))
    print(json.dumps({"sysfs": topology, "coverage": [{k: r[k] for k in ["rangeKiB", "sequential", "calls", "loopMs", "settled"]} for r in rows]}, indent=2))
    target.unlink()


if __name__ == "__main__":
    probe(*(Path(p) for p in sys.argv[1:]))
