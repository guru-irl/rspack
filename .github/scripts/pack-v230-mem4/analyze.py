#!/usr/bin/env python3
import json
import math
import os
import pathlib
import random
import statistics
import sys

STAGES = ("build", "edit1", "edit2")
MEMORY_FIELDS = ("rss_bytes", "heap_used_bytes", "heap_total_bytes", "external_bytes", "array_buffers_bytes")
PASS_FIELDS = (
    "elapsed_ms",
    "stats_ms",
    "codegen_ms",
    "render_ms",
    "process_assets_ms",
    "devtool_collect_ms",
    "devtool_emit_ms",
    "emit_ms",
)


def paired_summary(control, candidate, seed=613):
    if len(control) != len(candidate) or len(control) < 5:
        raise ValueError("at least five complete pairs are required")
    deltas = [b - a for a, b in zip(control, candidate)]
    rng = random.Random(seed)
    boot = sorted(statistics.median(rng.choices(deltas, k=len(deltas))) for _ in range(20000))
    return {
        "control_median": statistics.median(control),
        "candidate_median": statistics.median(candidate),
        "paired_delta_median": statistics.median(deltas),
        "bootstrap_95_low": boot[int(0.025 * (len(boot) - 1))],
        "bootstrap_95_high": boot[int(0.975 * (len(boot) - 1))],
        "paired_deltas": deltas,
    }


def load_samples(directory, pairs):
    if pairs < 5:
        raise ValueError("at least five complete pairs are required")
    samples = {}
    for arm in ("control", "candidate"):
        for pair in range(1, pairs + 1):
            record = json.loads((directory / f"metrics-{arm}-{pair}.json").read_text())
            usage = json.loads((directory / f"time-{arm}-{pair}.json").read_text())
            if len(record.get("builds", [])) != 3 or not record.get("binding"):
                raise ValueError(f"incomplete run {arm}/{pair}")
            for field in ("peak_kib", "wall_s", "user_s", "system_s"):
                value = usage.get(field)
                if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    raise ValueError(f"invalid {field} in {arm}/{pair}")
            if usage["peak_kib"] == 0:
                raise ValueError(f"invalid peak RSS {arm}/{pair}")
            for build in record["builds"]:
                for field in (*MEMORY_FIELDS, *PASS_FIELDS):
                    value = build.get(field)
                    if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                        raise ValueError(f"invalid {field} in {arm}/{pair}")
            samples[arm, pair] = (record, usage)
    return samples


def selected_metrics(selectors, requested):
    if not requested:
        return selectors
    names = requested.split(",")
    if len(set(names)) != len(names) or any(name not in selectors for name in names):
        raise ValueError(f"invalid metric selection: {requested}")
    return {name: selectors[name] for name in names}


def analyze(directory, pairs):
    samples = load_samples(directory, pairs)
    selectors = {
        "peak_rss_mib": lambda rec, usage: usage["peak_kib"] / 1024,
        "process_wall_s": lambda rec, usage: usage["wall_s"],
        "process_user_s": lambda rec, usage: usage["user_s"],
        "process_system_s": lambda rec, usage: usage["system_s"],
    }
    for index, stage in enumerate(STAGES):
        for field in MEMORY_FIELDS:
            name = field.removesuffix("_bytes")
            selectors[f"{stage}_{name}_mib"] = lambda rec, usage, index=index, field=field: rec["builds"][index][field] / 1048576
        for field in PASS_FIELDS:
            selectors[f"{stage}_{field}"] = lambda rec, usage, index=index, field=field: rec["builds"][index][field]
    selectors = selected_metrics(selectors, os.environ.get("REPORT_METRICS"))
    result = {"pairs": pairs, "candidate_minus_control": {}}
    for number, (name, select) in enumerate(selectors.items()):
        a = [select(*samples["control", i]) for i in range(1, pairs + 1)]
        b = [select(*samples["candidate", i]) for i in range(1, pairs + 1)]
        result["candidate_minus_control"][name] = paired_summary(a, b, seed=613 + number)
    return result


def self_test():
    assert selected_metrics({"a": 1, "b": 2}, "b") == {"b": 2}
    try:
        selected_metrics({"a": 1}, "missing")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown metric was accepted")
    better = paired_summary([10] * 5, [8] * 5)
    assert (better["paired_delta_median"], better["bootstrap_95_low"], better["bootstrap_95_high"]) == (-2, -2, -2)
    equal = paired_summary([10] * 5, [10] * 5)
    assert (equal["paired_delta_median"], equal["bootstrap_95_low"], equal["bootstrap_95_high"]) == (0, 0, 0)
    slower = paired_summary([10] * 5, [13] * 5)
    assert (slower["paired_delta_median"], slower["bootstrap_95_low"], slower["bootstrap_95_high"]) == (3, 3, 3)
    try:
        paired_summary([10] * 4, [8] * 4)
    except ValueError:
        pass
    else:
        raise AssertionError("incomplete pairs were accepted")
    missing = pathlib.Path("missing-sample-control")
    assert not missing.exists()
    try:
        load_samples(missing, 5)
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("missing sample files were accepted")
    print("analyzer controls passed: decrease, equality, regression, incomplete pairs, missing files")


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return
    if len(sys.argv) != 3:
        raise SystemExit("usage: analyze.py <result-directory> <pair-count>")
    directory = pathlib.Path(sys.argv[1])
    result = analyze(directory, int(sys.argv[2]))
    (directory / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    print("metric\tcontrol\tcandidate\tdelta\tbootstrap_95_low\tbootstrap_95_high")
    for name, value in result["candidate_minus_control"].items():
        print("\t".join([name] + [f"{value[key]:.3f}" for key in (
            "control_median", "candidate_median", "paired_delta_median", "bootstrap_95_low", "bootstrap_95_high"
        )]))


if __name__ == "__main__":
    main()
