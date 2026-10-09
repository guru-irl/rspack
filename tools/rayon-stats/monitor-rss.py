#!/usr/bin/env python3
"""Linux RssAnon monitor: metadata.json stdout.log stderr.log -- command [args]."""
import json
import subprocess
import sys
import time
from pathlib import Path

metadata, stdout, stderr = map(Path, sys.argv[1:4])
if sys.argv[4] != "--" or len(sys.argv) < 6:
    raise SystemExit(__doc__)
period = 0.005
samples = []
with stdout.open("wb") as out, stderr.open("wb") as err:
    process = subprocess.Popen(sys.argv[5:], stdout=out, stderr=err)
    status = Path(f"/proc/{process.pid}/status")
    while process.poll() is None:
        try:
            text = status.read_text()
            values = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
            if "RssAnon" in values and not values.get("State", "").strip().startswith("Z"):
                samples.append({"timestamp_ns": str(time.monotonic_ns()), "rss_anon_bytes": int(values["RssAnon"].split()[0]) * 1024})
        except (FileNotFoundError, ProcessLookupError):
            pass
        time.sleep(period)
    rc = process.wait()
report = {
    "exit_code": rc,
    "requested_period_ms": period * 1000,
    "samples": samples,
    "rss_anon_peak_bytes": max((x["rss_anon_bytes"] for x in samples), default=None),
    "rss_anon_end_bytes": samples[-1]["rss_anon_bytes"] if samples else None,
    "end_definition": "last live process sample before exit, excludes zombie observations",
}
metadata.write_text(json.dumps(report, indent=2) + "\n")
raise SystemExit(rc)
