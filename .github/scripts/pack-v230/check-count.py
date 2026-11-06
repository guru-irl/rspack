from pathlib import Path
import re
import sys


def passed_count(text):
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    summaries = re.findall(r"^\s*Tests\s+(.+)$", text, re.MULTILINE)
    assert summaries, "missing test summary"
    assert not any(re.search(r"\b[1-9][0-9]* failed\b", line) for line in summaries), "failed tests"
    counts = [int(n) for line in summaries for n in re.findall(r"\b([0-9]+) passed\b", line)]
    assert counts and sum(counts) >= 1, "no passing tests"
    return sum(counts)


if sys.argv[1:] == ["--selftest"]:
    assert passed_count("\x1b[90m Tests\x1b[0m \x1b[32m15 passed\x1b[0m | 210 skipped") == 15
    for bad in ("Tests 0 passed", "Tests 1 failed | 15 passed", "Test Files 1 passed"):
        try:
            passed_count(bad)
        except AssertionError:
            continue
        raise AssertionError("accepted an invalid summary")
    print("ANSI count positive control and 3 negative controls passed")
else:
    print("passed >= 1:", passed_count(Path(sys.argv[1]).read_text()))
