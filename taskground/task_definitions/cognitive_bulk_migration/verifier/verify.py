#!/usr/bin/env python3
"""Held-out verifier for cognitive_bulk_migration."""

from __future__ import annotations

import copy
import importlib
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

SCHEMA_VERSION = 1

STRING_CASES = {
    "account_id": ("account_id", "accountId"),
    "user_handle": ("handle", "userHandle"),
    "owner_key": ("owner", "ownerKey"),
    "profile_slug": ("slug", "profileSlug"),
}
CSV_CASES = {
    "tags": ("tags_csv", "tags"),
    "labels": ("labels_csv", "labels"),
    "topics": ("topic_list", "topics"),
    "scopes": ("scopes_text", "scopes"),
}
MONEY_CASES = {
    "amount_cents": ("amount", "amountCents"),
    "fee_cents": ("fee", "feeCents"),
    "balance_cents": ("balance", "balanceCents"),
    "tax_cents": ("tax", "taxCents"),
}
BOOL_CASES = {
    "enabled": ("enabled_text", "enabled"),
    "archived": ("archived_text", "archived"),
    "verified": ("verified_text", "verified"),
    "billable": ("billable_text", "billable"),
}
SPACE_CASES = {
    "display_name": ("display_name", "displayName"),
    "city": ("city_name", "city"),
    "country": ("country_name", "country"),
    "department": ("department_name", "department"),
}
CLAMP_CASES = {
    "retry_after": ("retry_after", "retryAfter", 0, 300, 30),
    "timeout_ms": ("timeout_ms", "timeoutMs", 50, 10000, 1000),
    "batch_size": ("batch_size", "batchSize", 1, 500, 100),
    "priority": ("priority", "priority", 0, 9, 5),
}

EXPECTED_CONTRACTS = {
    "account_id": "Read account_id. Strip surrounding whitespace, lowercase it, and emit it as accountId. Missing or None becomes the empty string. Preserve meta unchanged when present.",
    "user_handle": "Read handle. Strip surrounding whitespace, lowercase it, and emit it as userHandle. Missing or None becomes the empty string. Preserve meta unchanged when present.",
    "owner_key": "Read owner. Strip surrounding whitespace, lowercase it, and emit it as ownerKey. Missing or None becomes the empty string. Preserve meta unchanged when present.",
    "profile_slug": "Read slug. Strip surrounding whitespace, lowercase it, and emit it as profileSlug. Missing or None becomes the empty string. Preserve meta unchanged when present.",
    "tags": "Read tags_csv as comma-separated text. Split on commas, strip each item, lowercase each item, discard empty items, preserve order, and emit the list as tags. Missing or None becomes an empty list. Preserve meta unchanged when present.",
    "labels": "Read labels_csv as comma-separated text. Split on commas, strip each item, lowercase each item, discard empty items, preserve order, and emit the list as labels. Missing or None becomes an empty list. Preserve meta unchanged when present.",
    "topics": "Read topic_list as comma-separated text. Split on commas, strip each item, lowercase each item, discard empty items, preserve order, and emit the list as topics. Missing or None becomes an empty list. Preserve meta unchanged when present.",
    "scopes": "Read scopes_text as comma-separated text. Split on commas, strip each item, lowercase each item, discard empty items, preserve order, and emit the list as scopes. Missing or None becomes an empty list. Preserve meta unchanged when present.",
    "amount_cents": "Read amount. Convert a base-10 integer string or integer to an integer and emit it as amountCents. Missing, None, or blank text becomes 0. Negative values are invalid and must raise ValueError. Preserve meta unchanged when present.",
    "fee_cents": "Read fee. Convert a base-10 integer string or integer to an integer and emit it as feeCents. Missing, None, or blank text becomes 0. Negative values are invalid and must raise ValueError. Preserve meta unchanged when present.",
    "balance_cents": "Read balance. Convert a base-10 integer string or integer to an integer and emit it as balanceCents. Missing, None, or blank text becomes 0. Negative values are invalid and must raise ValueError. Preserve meta unchanged when present.",
    "tax_cents": "Read tax. Convert a base-10 integer string or integer to an integer and emit it as taxCents. Missing, None, or blank text becomes 0. Negative values are invalid and must raise ValueError. Preserve meta unchanged when present.",
    "enabled": "Read enabled_text. Accept booleans directly. For text, trim and ignore case: yes, true, 1, and on mean True; no, false, 0, off, and blank mean False. Missing or None means False. Any other value must raise ValueError. Emit enabled. Preserve meta unchanged when present.",
    "archived": "Read archived_text. Accept booleans directly. For text, trim and ignore case: yes, true, 1, and on mean True; no, false, 0, off, and blank mean False. Missing or None means False. Any other value must raise ValueError. Emit archived. Preserve meta unchanged when present.",
    "verified": "Read verified_text. Accept booleans directly. For text, trim and ignore case: yes, true, 1, and on mean True; no, false, 0, off, and blank mean False. Missing or None means False. Any other value must raise ValueError. Emit verified. Preserve meta unchanged when present.",
    "billable": "Read billable_text. Accept booleans directly. For text, trim and ignore case: yes, true, 1, and on mean True; no, false, 0, off, and blank mean False. Missing or None means False. Any other value must raise ValueError. Emit billable. Preserve meta unchanged when present.",
    "display_name": "Read display_name. Convert to text, trim outer whitespace, collapse every run of internal whitespace to one space, preserve letter case, and emit displayName. Missing or None becomes the empty string. Preserve meta unchanged when present.",
    "city": "Read city_name. Convert to text, trim outer whitespace, collapse every run of internal whitespace to one space, preserve letter case, and emit city. Missing or None becomes the empty string. Preserve meta unchanged when present.",
    "country": "Read country_name. Convert to text, trim outer whitespace, collapse every run of internal whitespace to one space, preserve letter case, and emit country. Missing or None becomes the empty string. Preserve meta unchanged when present.",
    "department": "Read department_name. Convert to text, trim outer whitespace, collapse every run of internal whitespace to one space, preserve letter case, and emit department. Missing or None becomes the empty string. Preserve meta unchanged when present.",
    "retry_after": "Read retry_after. Convert a base-10 integer string or integer to an integer, clamp it to the inclusive range 0..300, and emit retryAfter. Missing, None, or blank text uses default 30. Preserve meta unchanged when present.",
    "timeout_ms": "Read timeout_ms. Convert a base-10 integer string or integer to an integer, clamp it to the inclusive range 50..10000, and emit timeoutMs. Missing, None, or blank text uses default 1000. Preserve meta unchanged when present.",
    "batch_size": "Read batch_size. Convert a base-10 integer string or integer to an integer, clamp it to the inclusive range 1..500, and emit batchSize. Missing, None, or blank text uses default 100. Preserve meta unchanged when present.",
    "priority": "Read priority. Convert a base-10 integer string or integer to an integer, clamp it to the inclusive range 0..9, and emit priority. Missing, None, or blank text uses default 5. Preserve meta unchanged when present.",
}

def with_meta(output: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    result = dict(output)
    if "meta" in payload:
        result["meta"] = copy.deepcopy(payload["meta"])
    return result

def expect_string(source: str, target: str, payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get(source)
    value = "" if raw is None else str(raw).strip().lower()
    return with_meta({target: value}, payload)

def expect_csv(source: str, target: str, payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get(source)
    values = [] if raw is None else [item.strip().lower() for item in str(raw).split(",") if item.strip()]
    return with_meta({target: values}, payload)

def expect_money(source: str, target: str, payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get(source)
    value = 0 if raw is None or (isinstance(raw, str) and not raw.strip()) else int(raw)
    if value < 0:
        raise ValueError("negative")
    return with_meta({target: value}, payload)

def expect_bool(source: str, target: str, payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get(source)
    if raw is None:
        value = False
    elif isinstance(raw, bool):
        value = raw
    else:
        text = str(raw).strip().lower()
        if text in {"yes", "true", "1", "on"}:
            value = True
        elif text in {"no", "false", "0", "off", ""}:
            value = False
        else:
            raise ValueError("invalid boolean")
    return with_meta({target: value}, payload)

def expect_space(source: str, target: str, payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get(source)
    value = "" if raw is None else " ".join(str(raw).split())
    return with_meta({target: value}, payload)

def expect_clamp(source: str, target: str, low: int, high: int, default: int, payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get(source)
    value = default if raw is None or (isinstance(raw, str) and not raw.strip()) else int(raw)
    value = min(high, max(low, value))
    return with_meta({target: value}, payload)

def cases_for(name: str) -> list[tuple[dict[str, Any], Callable[[dict[str, Any]], dict[str, Any]], bool]]:
    meta = {"trace": name, "nested": {"n": 1}}
    if name in STRING_CASES:
        source, target = STRING_CASES[name]
        fn = lambda payload: expect_string(source, target, payload)
        return [({}, fn, False), ({source: "  MiXeD-42  ", "meta": meta}, fn, False), ({source: "Already-Clean"}, fn, False)]
    if name in CSV_CASES:
        source, target = CSV_CASES[name]
        fn = lambda payload: expect_csv(source, target, payload)
        return [({}, fn, False), ({source: " Alpha, beta ,,GAMMA ", "meta": meta}, fn, False), ({source: ",, one , two,"}, fn, False)]
    if name in MONEY_CASES:
        source, target = MONEY_CASES[name]
        fn = lambda payload: expect_money(source, target, payload)
        return [({}, fn, False), ({source: "0017", "meta": meta}, fn, False), ({source: 42}, fn, False), ({source: -1}, fn, True)]
    if name in BOOL_CASES:
        source, target = BOOL_CASES[name]
        fn = lambda payload: expect_bool(source, target, payload)
        return [({}, fn, False), ({source: True, "meta": meta}, fn, False), ({source: " OFF "}, fn, False), ({source: "maybe"}, fn, True)]
    if name in SPACE_CASES:
        source, target = SPACE_CASES[name]
        fn = lambda payload: expect_space(source, target, payload)
        return [({}, fn, False), ({source: "  Ada\t  Lovelace\nPhD ", "meta": meta}, fn, False), ({source: 12345}, fn, False)]
    if name in CLAMP_CASES:
        source, target, low, high, default = CLAMP_CASES[name]
        fn = lambda payload: expect_clamp(source, target, low, high, default, payload)
        return [({}, fn, False), ({source: str(low - 999), "meta": meta}, fn, False), ({source: high + 999}, fn, False), ({source: str((low + high) // 2)}, fn, False)]
    raise KeyError(name)

def main() -> int:
    workspace = Path(os.environ["TASKGROUND_WORKSPACE"]).resolve()
    result_path = Path(os.environ["TASKGROUND_RESULT"]).resolve()
    sys.path.insert(0, str(workspace))
    checks: list[dict[str, Any]] = []
    metrics: dict[str, Any] = {"adapters": len(EXPECTED_CONTRACTS), "heldOutCases": 0}

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "status": "passed" if passed else "failed", "detail": detail})

    try:
        public = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests"],
            cwd=workspace, text=True, capture_output=True, timeout=20,
        )
        add("public tests", public.returncode == 0, (public.stdout + public.stderr)[-3000:])

        contract_failures: list[str] = []
        behavior_failures: list[str] = []
        passed_cases = 0
        for name, contract in EXPECTED_CONTRACTS.items():
            try:
                module = importlib.import_module(f"adapters.{name}")
            except Exception as error:
                behavior_failures.append(f"{name}: import failed: {type(error).__name__}: {error}")
                continue
            if getattr(module, "CONTRACT", None) != contract:
                contract_failures.append(name)
            adapt = getattr(module, "adapt_event", None)
            if not callable(adapt):
                behavior_failures.append(f"{name}: adapt_event is not callable")
                continue
            for index, (payload, oracle, expects_error) in enumerate(cases_for(name)):
                metrics["heldOutCases"] += 1
                original = copy.deepcopy(payload)
                try:
                    expected = oracle(payload)
                except ValueError:
                    expected = None
                try:
                    actual = adapt(payload)
                    raised = False
                except ValueError:
                    actual = None
                    raised = True
                except Exception as error:
                    behavior_failures.append(f"{name}[{index}]: unexpected {type(error).__name__}: {error}")
                    continue
                if payload != original:
                    behavior_failures.append(f"{name}[{index}]: input payload mutated")
                    continue
                if expects_error:
                    if not raised:
                        behavior_failures.append(f"{name}[{index}]: expected ValueError")
                    else:
                        passed_cases += 1
                    continue
                if raised:
                    behavior_failures.append(f"{name}[{index}]: unexpected ValueError")
                    continue
                if type(actual) is not dict or actual != expected:
                    behavior_failures.append(f"{name}[{index}]: expected {expected!r}, got {actual!r}")
                    continue
                if actual is payload:
                    behavior_failures.append(f"{name}[{index}]: returned the input object")
                    continue
                passed_cases += 1

        metrics["passedHeldOutCases"] = passed_cases
        add("contracts unchanged", not contract_failures,
            "all contract strings preserved" if not contract_failures else "changed: " + ", ".join(contract_failures))
        add("held-out adapter behavior", not behavior_failures,
            f"{passed_cases}/{metrics['heldOutCases']} cases passed" if not behavior_failures else "; ".join(behavior_failures[:12]))

        report_path = workspace / "work/report.md"
        report_ok = report_path.is_file() and bool(report_path.read_text(encoding="utf-8").strip())
        add("retained migration report", report_ok, "work/report.md present" if report_ok else "work/report.md missing or empty")
    except Exception as error:
        add("verifier execution", False, f"{type(error).__name__}: {error}")
        metrics["traceback"] = traceback.format_exc(limit=8)

    passed = bool(checks) and all(check["status"] == "passed" for check in checks)
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "task": "cognitive_bulk_migration",
        "status": "passed" if passed else "failed",
        "checks": checks,
        "metrics": metrics,
        "limitations": [
            "Synthetic adapter family: measures bounded repository transformation, not broad coding quality.",
            "Cognitive allocation is interpreted from the agent's retained Taskground telemetry; the verifier scores outputs only.",
        ],
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
