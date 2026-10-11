"""Paired public blob-growth measurements with native process memory counters."""
import csv
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import threading
import time

import psutil

WORK = Path(os.environ["RUNNER_TEMP"]) / "new-cache-blobs"
OUT = WORK / "out"
SYSTEM = platform.system()
MIB = 1024 * 1024
if SYSTEM == "Darwin":
    native = ctypes.CDLL(str(WORK / "memory-macos.dylib"))
    native.footprint.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint64), ctypes.POINTER(ctypes.c_uint64)]
    native.footprint.restype = ctypes.c_int
elif SYSTEM == "Windows":
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize",
            "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]


def memory(pid):
    if SYSTEM == "Linux":
        fields = {}
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith(("RssAnon:", "VmHWM:", "VmRSS:")):
                key, value, _ = line.split()
                fields[key[:-1]] = int(value) * 1024
        if "RssAnon" not in fields:
            raise ProcessLookupError(pid)
        return {"current_bytes": fields["RssAnon"], "peak_bytes": fields["VmHWM"],
                "rss_bytes": fields["VmRSS"]}
    if SYSTEM == "Darwin":
        current, peak = ctypes.c_uint64(), ctypes.c_uint64()
        if native.footprint(pid, ctypes.byref(current), ctypes.byref(peak)):
            raise ProcessLookupError(pid)
        return {"current_bytes": current.value, "peak_bytes": peak.value}
    handle = kernel.OpenProcess(0x0400 | 0x0010, False, pid)
    if not handle:
        raise ProcessLookupError(pid)
    try:
        info = Counters()
        info.cb = ctypes.sizeof(info)
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(info), info.cb):
            raise OSError(ctypes.get_last_error())
        return {"current_bytes": info.PrivateUsage, "peak_bytes": info.PeakPagefileUsage,
                "working_set_bytes": info.WorkingSetSize, "peak_working_set_bytes": info.PeakWorkingSetSize}
    finally:
        kernel.CloseHandle(handle)


def arguments(database, filler, churn, cycles):
    return ["--dir", str(database), "--cycles", str(cycles), "--huge-keys", "3",
            "--huge-mib", "65", "--filler-mib", str(filler), "--churn-keys", str(churn)]


def binary(variant):
    return WORK / variant / ("target/release/blob-repro.exe" if os.name == "nt" else "target/release/blob-repro")


def fingerprint(directory):
    return {str(p.relative_to(directory)): (p.stat().st_size, p.stat().st_mtime_ns,
            hashlib.sha256(p.read_bytes()).hexdigest()) for p in directory.rglob("*") if p.is_file()}


OUT.mkdir(exist_ok=True)
(OUT / "host.json").write_text(json.dumps({
    "platform": platform.platform(), "cpu_count": os.cpu_count(),
    "memory_bytes": psutil.virtual_memory().total,
    "load_average": os.getloadavg() if hasattr(os, "getloadavg") else None,
    "memory_current_counter": {"Linux": "RssAnon", "Darwin": "phys_footprint", "Windows": "PrivateUsage"}[SYSTEM],
    "memory_peak_counter": {"Linux": "VmHWM (RSS, includes file pages)", "Darwin": "lifetime max phys_footprint", "Windows": "PeakPagefileUsage (peak commit)"}[SYSTEM],
    "processes": [p.info for p in psutil.process_iter(["name", "cpu_times"])],
}, default=str, indent=2))
results = []
for scenario, filler, churn in (("A", 0, 0), ("B", 1024, 2000)):
    seed = WORK / f"seed-{scenario}"
    with (OUT / f"seed-{scenario}.log").open("w") as log:
        subprocess.run([str(binary("baseline")), *arguments(seed, filler, churn, 0)],
                       stdout=log, stderr=log, check=True)
    seed_fingerprint = fingerprint(seed)
    for pair in range(1, 4):
        order = ("baseline", "patched") if pair % 2 else ("patched", "baseline")
        for variant in order:
            assert shutil.disk_usage(WORK).free > 10 * 1024**3, "Insufficient disk"
            assert psutil.virtual_memory().available > 2 * 1024**3, "Insufficient memory"
            name = f"{scenario}-{pair}-{variant}"
            database = WORK / f"db-{name}"
            shutil.copytree(seed, database, copy_function=shutil.copy2)
            assert fingerprint(database) == seed_fingerprint, "Cold seed bytes/mtime differ"
            samples, peaks, stdout, errors = [], {}, [], []
            with (OUT / f"{name}.stderr").open("w") as stderr:
                started = time.monotonic()
                process = subprocess.Popen([str(binary(variant)), *arguments(database, filler, churn, 20),
                    "--resume", "--pause-after-row"], stdout=subprocess.PIPE, stdin=subprocess.PIPE,
                    stderr=stderr, text=True, bufsize=1)
                lock = threading.Lock()
                def record():
                    sample = memory(process.pid)
                    with lock:
                        for key, value in sample.items():
                            peaks[key] = max(peaks.get(key, 0), value)
                    return sample
                def read_rows():
                    try:
                        for line in process.stdout:
                            stdout.append(line)
                            if line.startswith("rspack,"):
                                sample = record()
                                samples.append({"cycle": int(line.split(",")[1]), **sample})
                                process.stdin.write("sampled\n")
                                process.stdin.flush()
                    except Exception as error:
                        errors.append(repr(error))
                        process.kill()
                reader = threading.Thread(target=read_rows)
                reader.start()
                while process.poll() is None:
                    try:
                        record()
                    except (FileNotFoundError, ProcessLookupError):
                        pass
                    time.sleep(0.01)
                reader.join()
                wall_ms = (time.monotonic() - started) * 1000
            (OUT / f"{name}.csv").write_text("".join(stdout))
            assert not errors, errors
            assert process.returncode == 0, f"{name} failed: {process.returncode}"
            assert "read-back passed" in (OUT / f"{name}.stderr").read_text()
            rows = list(csv.DictReader(io.StringIO("".join(stdout))))
            assert len(rows) == 21 and len(samples) == 21, name
            if variant == "patched":
                assert all(int(row["dead_blobs"]) == 0 for row in rows), name
            warm = [s["current_bytes"] for s in samples if s["cycle"] >= 5]
            result = {"scenario": scenario, "pair": pair, "variant": variant,
                "wall_ms": wall_ms, "commit_median_ms": statistics.median(int(r["commit_us"]) / 1000 for r in rows[1:]),
                "final_blob_bytes": int(rows[-1]["blob_bytes"]), "final_directory_bytes": int(rows[-1]["total_bytes"]),
                "final_dead_blobs": int(rows[-1]["dead_blobs"]), "sampled_peaks": peaks,
                "warm_current_median_bytes": statistics.median(warm), "warm_current_max_bytes": max(warm),
                "post_readback_samples": samples}
            results.append(result)
            (OUT / f"{name}.json").write_text(json.dumps(result, indent=2))
            print(json.dumps({k: v for k, v in result.items() if k != "post_readback_samples"}), flush=True)
            shutil.rmtree(database)
    shutil.rmtree(seed)
(OUT / "results.json").write_text(json.dumps(results, indent=2))
