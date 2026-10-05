#!/usr/bin/env python3
"""Coverage gate for the OpenFGA API: every RPC is called and asserted.

Runs the integration suite (tests/integration) and requires, for every RPC
declared in the vendored API definitions (docs/repos/api), two independent
pieces of evidence from this run:

1. test side: at least one *passing* test named `[rpc:<Name>] ...`;
2. server side: OpenFGA's Prometheus counter grpc_server_handled_total grew
   for that method during the run (metrics are scraped before and after, so
   earlier runs don't count), with code OK, or with the code the RPC is
   expected to return (UpdateStore: Unimplemented).

The AuthZEN service is experimental: required only with FGA_EXPERIMENTAL=1
(default), otherwise listed as excluded.

Environment: the integration suite's FGA_API_URL, FGA_API_TOKEN, FGA_GRPC_ADDR,
FGA_METRICS_URL, FGA_EXPERIMENTAL (defaults: the compose stack in
tests/integration). Needs node, the fga CLI and grpcurl on PATH.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUITE = os.path.join(ROOT, "tests", "integration")
PROTOS = {
    "openfga.v1.OpenFGAService": os.path.join(ROOT, "docs", "repos", "api", "openfga", "v1", "openfga_service.proto"),
    "authzen.v1.AuthZenService": os.path.join(ROOT, "docs", "repos", "api", "authzen", "v1", "authzen_service.proto"),
}
EXPERIMENTAL_SERVICES = {"authzen.v1.AuthZenService"}
# RPCs that exist in the API definition but that OpenFGA doesn't implement:
# the suite must show the server answering with this code.
EXPECTED_CODE = {"UpdateStore": "Unimplemented"}

METRICS_URL = os.environ.get("FGA_METRICS_URL", "http://127.0.0.1:22112/metrics")
API_URL = os.environ.get("FGA_API_URL", "http://127.0.0.1:28080")
EXPERIMENTAL = os.environ.get("FGA_EXPERIMENTAL", "1") == "1"
METRIC_RE = re.compile(r'^grpc_server_handled_total\{([^}]*)\}\s+([0-9.e+]+)$')


def rpcs(proto: str) -> list[str]:
    with open(proto) as f:
        return re.findall(r"^\s*rpc\s+(\w+)\s*\(", f.read(), re.M)


def scrape() -> dict[tuple[str, str, str], float]:
    with urllib.request.urlopen(METRICS_URL, timeout=10) as res:
        text = res.read().decode()
    counts = {}
    for line in text.splitlines():
        m = METRIC_RE.match(line)
        if not m:
            continue
        labels = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        counts[(labels.get("grpc_service", ""), labels.get("grpc_method", ""), labels.get("grpc_code", ""))] = float(m.group(2))
    return counts


def passing_rpc_tests(tap: str) -> dict[str, int]:
    """Count passing, non-skipped `[rpc:X]` tests in TAP output."""
    counts: dict[str, int] = {}
    for line in tap.splitlines():
        m = re.match(r"^\s*ok \d+ - \[rpc:(\w+)\]", line)
        if m and "# SKIP" not in line:
            counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    return counts


def wait_ready(timeout: float = 90) -> bool:
    """Wait until OpenFGA reports SERVING (its readiness includes the datastore)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{API_URL}/healthz", timeout=5) as res:
                if b"SERVING" in res.read():
                    return True
        except OSError:
            pass
        time.sleep(2)
    return False


def main() -> int:
    expected = {svc: rpcs(path) for svc, path in PROTOS.items()}
    if not wait_ready():
        print(f"FAIL: OpenFGA at {API_URL} isn't SERVING")
        return 1
    try:
        before = scrape()
    except OSError as err:
        print(f"FAIL: can't read metrics at {METRICS_URL}: {err}")
        return 1

    tap_path = os.path.join(SUITE, "results.tap")
    if os.path.exists(tap_path):
        os.remove(tap_path)  # never count a previous run's results
    run = subprocess.run(["npm", "test", "--silent"], cwd=SUITE)
    tap = open(tap_path).read() if os.path.exists(tap_path) else ""
    after = scrape()

    tested = passing_rpc_tests(tap)
    served: dict[tuple[str, str], set[str]] = {}
    for (svc, method, code), value in after.items():
        if value - before.get((svc, method, code), 0) > 0:
            served.setdefault((svc, method), set()).add(code)

    failures = 0 if run.returncode == 0 else 1
    if run.returncode != 0:
        print("FAIL: the integration suite failed")
    total = 0
    for svc, methods in expected.items():
        excluded = svc in EXPERIMENTAL_SERVICES and not EXPERIMENTAL
        for method in methods:
            total += 1
            if excluded:
                print(f"  excluded {svc}/{method} (experimental tier off)")
                continue
            want = EXPECTED_CODE.get(method, "OK")
            codes = served.get((svc, method), set())
            problems = []
            if tested.get(method, 0) == 0:
                problems.append("no passing [rpc:%s] test" % method)
            if want not in codes:
                problems.append(f"server didn't serve it with code {want} during the run (saw: {sorted(codes) or 'nothing'})")
            if problems:
                failures += 1
                print(f"  FAIL {svc}/{method}: " + "; ".join(problems))
            else:
                print(f"  ok   {svc}/{method}: {tested[method]} test(s), server codes {sorted(codes)}")

    print(f"api coverage: {total} RPCs declared, {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
