"""Paired public blob-growth measurements. A failed command is never a sample."""

import csv
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import statistics
import subprocess
import threading
import time

import psutil

WORK = Path(os.environ["GITHUB_WORKSPACE"]).parent / ".spider/scratch/new-cache-blobs"
OUT = WORK / "out"
MIB = 1024 * 1024
results = []
(OUT / "host.json").write_text(json.dumps({
    "platform": platform.platform(),
    "cpu_count": os.cpu_count(),
    "memory_bytes": psutil.virtual_memory().total,
    "load_average": os.getloadavg() if hasattr(os, "getloadavg") else None,
    "processes": [p.info for p in psutil.process_iter(["name", "cpu_times"])],
}, default=str, indent=2))

for scenario, filler, churn in (("A", 0, 0), ("B", 1024, 2000)):
    for pair in range(1, 4):
        order = ("baseline", "patched") if pair % 2 else ("patched", "baseline")
        for variant in order:
            name = f"{scenario}-{pair}-{variant}"
            database = WORK / f"db-{name}"
            suffix = ".exe" if os.name == "nt" else ""
            binary = WORK / variant / f"target/release/blob-repro{suffix}"
            command = [str(binary), "--dir", str(database), "--cycles", "20",
                       "--huge-keys", "3", "--huge-mib", "65",
                       "--filler-mib", str(filler), "--churn-keys", str(churn)]
            native = OUT / f"{name}.stderr"
            if os.name != "nt":
                flags = ["-l"] if platform.system() == "Darwin" else ["-v"]
                command = ["/usr/bin/time", *flags, *command]
            assert shutil.disk_usage(WORK).free > 10 * 1024**3, "Insufficient disk"
            samples = []
            peak = 0
            windows_peak = 0
            stdout = []
            stderr = (OUT / f"{name}.stderr").open("w")
            started = time.monotonic()
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=stderr,
                                       text=True, bufsize=1)

            def memory():
                # /usr/bin/time is the parent on Unix; include its live harness child.
                try:
                    root = psutil.Process(process.pid)
                    candidates = root.children(recursive=True) or [root]
                    infos = [p.memory_info() for p in candidates]
                    return (sum(m.rss for m in infos),
                            max((getattr(m, "peak_wset", 0) for m in infos), default=0))
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    return 0, 0

            def read_rows():
                for line in process.stdout:
                    stdout.append(line)
                    if line.startswith("rspack,"):
                        rss, _ = memory()
                        samples.append({"cycle": int(line.split(",")[1]), "rss_bytes": rss})

            reader = threading.Thread(target=read_rows)
            reader.start()
            while process.poll() is None:
                rss, native_peak = memory()
                peak = max(peak, rss)
                windows_peak = max(windows_peak, native_peak)
                time.sleep(0.01)
            reader.join()
            stderr.close()
            (OUT / f"{name}.csv").write_text("".join(stdout))
            assert process.returncode == 0, f"{name} failed: {process.returncode}"
            assert "read-back passed" in (OUT / f"{name}.stderr").read_text()
            if os.name == "nt":
                peak = max(peak, windows_peak)
            else:
                text = native.read_text()
                pattern = (r"(\d+)\s+maximum resident set size" if platform.system() == "Darwin"
                           else r"Maximum resident set size \(kbytes\):\s*(\d+)")
                match = re.search(pattern, text)
                assert match, text
                peak = int(match.group(1)) * (1 if platform.system() == "Darwin" else 1024)
            rows = list(csv.DictReader(io.StringIO("".join(stdout))))
            assert len(rows) == 21, f"Missing cycle rows: {name}"
            if variant == "patched":
                assert all(int(row["dead_blobs"]) == 0 for row in rows), name
            warm_rss = [s["rss_bytes"] for s in samples if s["cycle"] >= 5 and s["rss_bytes"]]
            assert warm_rss, f"Missing RSS samples: {name}"
            result = {
                "scenario": scenario, "pair": pair, "variant": variant,
                "wall_ms": (time.monotonic() - started) * 1000,
                "commit_ms": statistics.median(float(r["commit_us"]) / 1000 for r in rows[1:]),
                "peak_rss_bytes": peak,
                "steady_rss_bytes": statistics.median(warm_rss),
                "rss_cycles": samples,
                "cycles": rows,
            }
            results.append(result)
            (OUT / "results.json").write_text(json.dumps(results, indent=2))
            print(f"{name}: commit {result['commit_ms']:.2f} ms, peak {peak / MIB:.2f} MiB, "
                  f"steady {result['steady_rss_bytes'] / MIB:.2f} MiB, "
                  f"dead blobs {rows[-1]['dead_blobs']}", flush=True)
            if (database / "LOG").exists():
                shutil.copy2(database / "LOG", OUT / f"{name}.LOG")
            shutil.rmtree(database)
