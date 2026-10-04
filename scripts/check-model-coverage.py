#!/usr/bin/env python3
"""Coverage gate for the OpenFGA model tests (authz/models/*.fga.yaml).

Counts only what actually ran, from `fga model test --verbose`, not what the
YAML files claim, and fails when:

1. a relation lacks a passing check expected `true` or one expected `false`;
2. an object type lacks a passing list_objects or list_users assertion;
3. a mutant of the model survives: the model is broken one rule at a time
   (drop a branch of `or`, turn `and` into `or`, drop `but not`, drop an
   allowed subject type, negate a condition) and the tests must fail for each.
   A surviving mutant means some rule isn't really tested.

Mutants listed in authz/models/coverage-exemptions.txt (one id per line,
`# reason` required) are reported but don't fail the gate.

Usage: scripts/check-model-coverage.py [--no-mutants] [--jobs N]
Requires the fga CLI (versions.env: FGA_CLI_VERSION) on PATH.
"""

from __future__ import annotations

import argparse
import copy
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "authz", "models")
MANIFEST = os.path.join(MODELS, "fga.mod")
EXEMPTIONS = os.path.join(MODELS, "coverage-exemptions.txt")
TEST_GLOB = os.path.join(MODELS, "*.fga.yaml")


def fga(*args: str, cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["fga", *args], cwd=cwd, capture_output=True, text=True)


def compiled_model() -> dict:
    out = fga("model", "transform", "--file", MANIFEST, "--output-format", "json")
    if out.returncode != 0:
        sys.exit(f"fga model transform failed:\n{out.stderr}")
    return json.loads(out.stdout)


def run_tests(test_glob: str) -> tuple[bool, list]:
    """Run the model tests; return (all passed, verbose results)."""
    out = fga("model", "test", "--tests", test_glob, "--verbose", "--suppress-summary")
    try:
        results = json.loads(out.stdout) if out.stdout.strip() else []
    except json.JSONDecodeError:
        results = []
    return out.returncode == 0, results


def type_of(ref: str) -> str:
    return ref.split(":", 1)[0]


# --- 1 + 2: coverage of what actually ran -----------------------------------

def coverage_problems(model: dict, results: list) -> list[str]:
    relations = {
        (td["type"], rel)
        for td in model["type_definitions"]
        for rel in (td.get("relations") or {})
    }
    types_with_relations = {t for t, _ in relations}
    seen_true, seen_false = set(), set()
    listed_objects, listed_users = set(), set()

    for test in results:
        for r in test.get("check_results") or []:
            if not r.get("test_result"):
                continue
            key = (type_of(r["request"]["object"]), r["request"]["relation"])
            (seen_true if r["expected"] else seen_false).add(key)
        for r in test.get("list_objects_results") or []:
            if r.get("test_result"):
                listed_objects.add(r["request"]["type"])
        for r in test.get("list_users_results") or []:
            if r.get("test_result"):
                obj = r["request"]["object"]
                listed_users.add(obj["type"] if isinstance(obj, dict) else type_of(obj))

    problems = []
    for t, rel in sorted(relations):
        missing = [w for w, s in (("true", seen_true), ("false", seen_false)) if (t, rel) not in s]
        if missing:
            problems.append(f"{t}#{rel}: no passing check expected {' or '.join(missing)}")
    for t in sorted(types_with_relations):
        if t not in listed_objects:
            problems.append(f"type {t}: no passing list_objects assertion")
        if t not in listed_users:
            problems.append(f"type {t}: no passing list_users assertion")
    return problems


# --- 3: mutation testing ---------------------------------------------------------

def rewrite_mutants(node: dict, path: str):
    """Yield (description, replacement) for every single-rule break of a rewrite."""
    for op in ("union", "intersection"):
        if op in node:
            children = node[op]["child"]
            for i, child in enumerate(children):
                rest = children[:i] + children[i + 1:]
                replacement = rest[0] if len(rest) == 1 else {op: {"child": rest}}
                yield f"{path}: drop {op} child {i} ({describe(child)})", replacement
            if op == "intersection":
                yield f"{path}: intersection -> union", {"union": {"child": children}}
            for i, child in enumerate(children):
                for desc, sub in rewrite_mutants(child, f"{path}.{op}[{i}]"):
                    new = copy.deepcopy(children)
                    new[i] = sub
                    yield desc, {op: {"child": new}}
    if "difference" in node:
        diff = node["difference"]
        yield f"{path}: drop 'but not' ({describe(diff['subtract'])})", diff["base"]
        for part in ("base", "subtract"):
            for desc, sub in rewrite_mutants(diff[part], f"{path}.{part}"):
                new = copy.deepcopy(diff)
                new[part] = sub
                yield desc, {"difference": new}


def has_direct(node: dict) -> bool:
    if "this" in node:
        return True
    for op in ("union", "intersection"):
        if op in node:
            return any(has_direct(c) for c in node[op]["child"])
    if "difference" in node:
        return has_direct(node["difference"]["base"]) or has_direct(node["difference"]["subtract"])
    return False


def describe(node: dict) -> str:
    if "this" in node:
        return "direct"
    if "computedUserset" in node:
        return node["computedUserset"]["relation"]
    if "tupleToUserset" in node:
        t = node["tupleToUserset"]
        return f"{t['computedUserset']['relation']} from {t['tupleset']['relation']}"
    return next(iter(node))


def type_ref(r: dict) -> str:
    s = r["type"]
    if "wildcard" in r:
        s += ":*"
    if r.get("relation"):
        s += "#" + r["relation"]
    if r.get("condition"):
        s += " with " + r["condition"]
    return s


def mutants(model: dict):
    """Yield (id, mutated model) for every single-rule break of the model."""
    for ti, td in enumerate(model["type_definitions"]):
        for rel, rewrite in (td.get("relations") or {}).items():
            base = f"{td['type']}#{rel}"
            for desc, replacement in rewrite_mutants(rewrite, base):
                m = copy.deepcopy(model)
                m["type_definitions"][ti]["relations"][rel] = replacement
                if has_direct(rewrite) and not has_direct(replacement):
                    # Dropping the direct-grant branch must drop its allowed
                    # types too, or the mutant isn't a valid model.
                    m["type_definitions"][ti]["metadata"]["relations"][rel]["directly_related_user_types"] = []
                yield desc, m
            allowed = td.get("metadata", {}).get("relations", {}).get(rel, {}).get("directly_related_user_types", [])
            if len(allowed) > 1:
                for i, r in enumerate(allowed):
                    m = copy.deepcopy(model)
                    lst = m["type_definitions"][ti]["metadata"]["relations"][rel]["directly_related_user_types"]
                    del lst[i]
                    yield f"{base}: drop allowed type [{type_ref(r)}]", m
    for name, cond in (model.get("conditions") or {}).items():
        m = copy.deepcopy(model)
        m["conditions"][name]["expression"] = f"!({cond['expression']})"
        yield f"condition {name}: negated", m


def run_mutant(item, test_files: list[str]) -> tuple[str, str]:
    """Return (id, 'killed' | 'survived' | 'invalid')."""
    desc, model = item
    with tempfile.TemporaryDirectory() as tmp:
        model_path = os.path.join(tmp, "mutant.json")
        with open(model_path, "w") as f:
            json.dump(model, f)
        if fga("model", "validate", "--file", model_path).returncode != 0:
            return desc, "invalid"
        for src in test_files:
            with open(src) as f:
                text = f.read()
            # Test files sit next to the model they test (the CLI refuses
            # model files outside the test file's directory).
            text = text.replace("model_file: ./fga.mod", "model_file: ./mutant.json")
            with open(os.path.join(tmp, os.path.basename(src)), "w") as f:
                f.write(text)
        passed, _ = run_tests(os.path.join(tmp, "*.fga.yaml"))
        return desc, "survived" if passed else "killed"


def load_exemptions() -> dict[str, str]:
    exemptions = {}
    if os.path.exists(EXEMPTIONS):
        for line in open(EXEMPTIONS):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            mid, _, reason = line.partition("  # ")
            if not reason.strip():
                sys.exit(f"{EXEMPTIONS}: exemption without a '  # reason': {line}")
            exemptions[mid.strip()] = reason.strip()
    return exemptions


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-mutants", action="store_true", help="skip mutation testing")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    args = ap.parse_args()

    if shutil.which("fga") is None:
        sys.exit("fga CLI not found on PATH (see versions.env for the version)")

    model = compiled_model()
    passed, results = run_tests(TEST_GLOB)
    if not passed:
        print("FAIL: the model tests themselves fail; fix them first (fga model test --tests 'authz/models/*.fga.yaml')")
        return 1

    problems = coverage_problems(model, results)
    n_rel = sum(len(td.get("relations") or {}) for td in model["type_definitions"])
    print(f"coverage: {n_rel} relations, {len(problems)} gap(s)")
    for p in problems:
        print(f"  FAIL {p}")

    survivors = []
    if not args.no_mutants:
        test_files = sorted(glob.glob(TEST_GLOB))
        exemptions = load_exemptions()
        # Control: the unchanged model, written and run exactly like a mutant,
        # must pass. Otherwise every mutant would "fail" for the wrong reason
        # and look killed.
        _, control = run_mutant(("control", model), test_files)
        if control != "survived":
            print(f"FAIL: control run with the unchanged model did not pass ({control}); mutation results would be meaningless")
            return 1
        items = list(mutants(model))
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            outcomes = list(pool.map(lambda it: run_mutant(it, test_files), items))
        counts = {k: sum(1 for _, o in outcomes if o == k) for k in ("killed", "survived", "invalid")}
        print(f"mutants: {len(items)} generated, {counts['killed']} killed, "
              f"{counts['survived']} survived, {counts['invalid']} invalid (skipped)")
        for desc, outcome in outcomes:
            if outcome == "invalid":
                print(f"  skipped  {desc}  (mutant is not a valid model)")
            if outcome != "survived":
                continue
            if desc in exemptions:
                print(f"  exempt   {desc}  ({exemptions[desc]})")
            else:
                print(f"  SURVIVED {desc}")
                survivors.append(desc)
        stale = set(exemptions) - {d for d, o in outcomes if o == "survived"}
        for desc in sorted(stale):
            print(f"  FAIL stale exemption (mutant no longer survives): {desc}")
            survivors.append(desc)

    return 1 if problems or survivors else 0


if __name__ == "__main__":
    sys.exit(main())
