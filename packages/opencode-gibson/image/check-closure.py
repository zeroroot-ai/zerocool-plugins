#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
# Copyright 2026 Zero Root AI
"""Check the dependency closure of the semgrep venv after a --no-deps install.

The venv is installed with `pip install --no-deps --require-hashes`, because
semgrep pins mcp==1.29.0 (CVE-2026-115563) and requirements.txt pins a newer
mcp. --no-deps removes pip's own closure check, so this script puts it back:
it runs `pip check` and fails on any missing requirement and on any conflict
except the one known pin, semgrep -> mcp==1.29.0 exactly, while mcp 1.30.x is
installed. The allowance is keyed by package names and the requirement spec,
never by a line number.

  check-closure.py <pip>                run `<pip> check`
  check-closure.py --from-file <file>   read the output of `pip check` from a file (the guard selftest)
"""
import re
import subprocess
import sys

# "semgrep 1.182.1 has requirement mcp==1.29.0, but you have mcp 1.30.0."
ALLOWED = re.compile(r"^semgrep \S+ has requirement mcp==1\.29\.0, but you have mcp 1\.30\.\d+\.$")
OK = "No broken requirements found."


def problems(output: str) -> list[str]:
    """The lines of `pip check` that are not the one allowed conflict."""
    out = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line == OK or ALLOWED.match(line):
            continue
        out.append(line)
    return out


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "--from-file":
        output = open(argv[2], encoding="utf-8").read()
    elif len(argv) == 2:
        # pip check exits 1 on the allowed conflict, so the exit code is not read. The lines are.
        run = subprocess.run([argv[1], "check"], capture_output=True, text=True)
        output = run.stdout + run.stderr
        if run.returncode not in (0, 1):
            print(f"closure check: pip check failed to run (exit {run.returncode}): {output.strip()}", file=sys.stderr)
            return 2
    else:
        print(__doc__, file=sys.stderr)
        return 2
    bad = problems(output)
    if bad:
        print("closure check: the venv has a missing requirement or a conflict that is not allowed:", file=sys.stderr)
        for line in bad:
            print(f"  {line}", file=sys.stderr)
        return 1
    print("closure check: the closure is complete")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
