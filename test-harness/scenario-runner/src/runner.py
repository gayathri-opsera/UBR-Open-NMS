"""
Scenario engine: parses YAML scenario definitions, executes steps, evaluates
assertions, and produces structured results.

Supports parallel execution for mixed-mode discovery scenarios (WO-042).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Callable

import yaml


# ── Result model ──────────────────────────────────────────────────────────────

class StepStatus(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    SKIP = "SKIP"


@dataclass
class StepResult:
    name: str
    status: StepStatus
    duration_ms: float
    error: Optional[str] = None
    details: Optional[str] = None


@dataclass
class ParallelStageResult:
    """Result from a parallel execution stage (WO-042)."""
    name: str
    parallel_steps: List[StepResult]
    duration_ms: float
    status: StepStatus

    @property
    def passed(self) -> bool:
        return all(step.status == StepStatus.PASS for step in self.parallel_steps)


@dataclass
class ScenarioResult:
    name: str
    description: str
    status: StepStatus
    duration_ms: float
    steps: List[StepResult] = field(default_factory=list)
    parallel_stages: List[ParallelStageResult] = field(default_factory=list)
    context: Dict[str, Any] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.status == StepStatus.PASS

    @property
    def step_summary(self) -> str:
        counts = {s: sum(1 for r in self.steps if r.status == s) for s in StepStatus}
        return f"PASS={counts[StepStatus.PASS]} FAIL={counts[StepStatus.FAIL]} SKIP={counts[StepStatus.SKIP]}"


# ── Scenario parser ───────────────────────────────────────────────────────────

def load_scenario(path: str) -> dict:
    with open(path) as f:
        raw = f.read()
    # Expand environment variables (${VAR} or ${VAR:default})
    raw = _expand_env(raw)
    return yaml.safe_load(raw)


def _expand_env(text: str) -> str:
    def replacer(m):
        name = m.group(1)
        default = m.group(3)
        value = os.environ.get(name, default or "")
        return value
    return re.sub(r"\$\{([A-Z0-9_]+)(:([^}]*))?\}", replacer, text)


def parse_scenario(data: dict) -> dict:
    """Validate a loaded scenario dict; raise ValueError for schema errors."""
    required = ("name", "steps")
    for key in required:
        if key not in data:
            raise ValueError(f"Scenario missing required field: {key}")
    for i, step in enumerate(data["steps"]):
        if "name" not in step:
            raise ValueError(f"Step {i} missing 'name'")
        if "action" not in step:
            raise ValueError(f"Step {i} ('{step.get('name')}') missing 'action'")
    return data


# ── Assertion evaluator ───────────────────────────────────────────────────────

def evaluate_assertion(assertion: dict, context: dict) -> tuple[bool, str]:
    """
    Evaluates a single assertion dictionary against the current context.
    Returns (passed: bool, detail: str).
    """
    kind = assertion.get("type", "equals")
    actual = _resolve(assertion.get("actual", ""), context)
    expected = assertion.get("expected")

    if kind == "equals":
        ok = str(actual) == str(expected)
        return ok, f"{actual!r} == {expected!r}" if ok else f"{actual!r} != {expected!r}"
    elif kind == "contains":
        ok = str(expected) in str(actual)
        return ok, f"{actual!r} contains {expected!r}" if ok else f"{actual!r} does not contain {expected!r}"
    elif kind == "gt":
        try:
            ok = float(actual) > float(expected)
            return ok, f"{actual} > {expected}" if ok else f"{actual} not > {expected}"
        except (TypeError, ValueError):
            return False, f"Cannot compare {actual!r} > {expected!r}"
    elif kind == "gte":
        try:
            ok = float(actual) >= float(expected)
            return ok, f"{actual} >= {expected}" if ok else f"{actual} not >= {expected}"
        except (TypeError, ValueError):
            return False, f"Cannot compare {actual!r} >= {expected!r}"
    elif kind == "not_empty":
        ok = bool(actual)
        return ok, "value is non-empty" if ok else "value is empty"
    else:
        return False, f"Unknown assertion type: {kind}"


def _resolve(expr: str, context: dict) -> Any:
    """Resolve a ${variable} expression from context."""
    if isinstance(expr, str) and expr.startswith("${") and expr.endswith("}"):
        key = expr[2:-1]
        return context.get(key, expr)
    return expr


# ── Parallel execution (WO-042) ──────────────────────────────────────────────

async def execute_parallel_stage(
    stage_name: str,
    tasks: List[Callable],
    timeout_seconds: float,
    shared_context: Dict[str, Any]
) -> ParallelStageResult:
    """
    Execute multiple async tasks in parallel with a shared deadline.
    Returns a ParallelStageResult with aggregated results from all tasks.
    """
    start_time = time.time()
    results: List[StepResult] = []

    try:
        # Run all tasks concurrently with timeout
        task_results = await asyncio.wait_for(
            asyncio.gather(*[task(shared_context) for task in tasks], return_exceptions=True),
            timeout=timeout_seconds
        )

        # Process results
        for i, result in enumerate(task_results):
            if isinstance(result, Exception):
                results.append(StepResult(
                    name=f"{stage_name}_task_{i}",
                    status=StepStatus.FAIL,
                    duration_ms=(time.time() - start_time) * 1000,
                    error=str(result)
                ))
            elif isinstance(result, StepResult):
                results.append(result)
            else:
                # Unexpected result type
                results.append(StepResult(
                    name=f"{stage_name}_task_{i}",
                    status=StepStatus.FAIL,
                    duration_ms=(time.time() - start_time) * 1000,
                    error=f"Unexpected result type: {type(result)}"
                ))

        # Determine overall status
        if all(r.status == StepStatus.PASS for r in results):
            status = StepStatus.PASS
        else:
            status = StepStatus.FAIL

    except asyncio.TimeoutError:
        status = StepStatus.FAIL
        results.append(StepResult(
            name=f"{stage_name}_timeout",
            status=StepStatus.FAIL,
            duration_ms=timeout_seconds * 1000,
            error=f"Stage timeout after {timeout_seconds}s"
        ))
    except Exception as e:
        status = StepStatus.FAIL
        results.append(StepResult(
            name=f"{stage_name}_error",
            status=StepStatus.FAIL,
            duration_ms=(time.time() - start_time) * 1000,
            error=f"Stage execution error: {str(e)}"
        ))

    duration_ms = (time.time() - start_time) * 1000
    return ParallelStageResult(
        name=stage_name,
        parallel_steps=results,
        duration_ms=duration_ms,
        status=status
    )


def poll_until(
    check_fn: Callable[[], tuple[bool, Any]],
    timeout_seconds: float = 30,
    interval_seconds: float = 1.0,
    description: str = "condition"
) -> tuple[bool, Any, str]:
    """
    Poll a check function until it returns True or timeout expires.
    Returns (success, final_value, detail_message).
    Used for API polling assertions in mixed discovery scenarios.
    """
    start_time = time.time()
    attempts = 0
    last_value = None

    while (time.time() - start_time) < timeout_seconds:
        attempts += 1
        try:
            passed, value = check_fn()
            last_value = value
            if passed:
                elapsed = time.time() - start_time
                return True, value, f"{description} passed after {elapsed:.1f}s ({attempts} attempts)"
        except Exception as e:
            last_value = f"Error: {e}"

        time.sleep(interval_seconds)

    elapsed = time.time() - start_time
    return False, last_value, f"{description} failed after {elapsed:.1f}s ({attempts} attempts)"


# ── Report generator ──────────────────────────────────────────────────────────

def generate_json_report(results: List[ScenarioResult]) -> dict:
    total = len(results)
    passed = sum(1 for r in results if r.passed)
    return {
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
            "pass_rate": round(passed / total * 100, 1) if total else 0,
        },
        "scenarios": [
            {
                "name": r.name,
                "description": r.description,
                "status": r.status.value,
                "duration_ms": r.duration_ms,
                "step_summary": r.step_summary,
                "steps": [
                    {
                        "name": s.name,
                        "status": s.status.value,
                        "duration_ms": s.duration_ms,
                        "error": s.error,
                        "details": s.details,
                    }
                    for s in r.steps
                ],
            }
            for r in results
        ],
    }


def generate_html_report(results: List[ScenarioResult]) -> str:
    report = generate_json_report(results)
    summary = report["summary"]
    pass_color = "#22c55e" if summary["failed"] == 0 else "#ef4444"

    rows = []
    for scenario in report["scenarios"]:
        status_badge = (
            '<span style="background:#22c55e;color:#fff;padding:2px 8px;border-radius:4px">PASS</span>'
            if scenario["status"] == "PASS"
            else '<span style="background:#ef4444;color:#fff;padding:2px 8px;border-radius:4px">FAIL</span>'
        )
        step_rows = "".join(
            f'<tr><td style="padding:4px 8px">{s["name"]}</td>'
            f'<td style="color:{"green" if s["status"] == "PASS" else "red"}">{s["status"]}</td>'
            f'<td>{s["duration_ms"]:.0f}ms</td>'
            f'<td style="color:#666;font-size:12px">{s.get("error") or s.get("details") or ""}</td></tr>'
            for s in scenario["steps"]
        )
        rows.append(f"""
        <tr>
          <td style="padding:8px"><strong>{scenario["name"]}</strong><br>
            <small style="color:#666">{scenario["description"]}</small></td>
          <td style="padding:8px">{status_badge}</td>
          <td style="padding:8px">{scenario["duration_ms"]:.0f}ms</td>
          <td style="padding:8px">{scenario["step_summary"]}</td>
        </tr>
        <tr><td colspan="4" style="padding:0 24px 8px">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr style="background:#f3f4f6"><th>Step</th><th>Status</th><th>Duration</th><th>Detail</th></tr>
            {step_rows}
          </table>
        </td></tr>
        """)

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>UBR NMS Integration Test Report</title>
<style>body{{font-family:system-ui,sans-serif;padding:24px;background:#f8fafc}}
table{{border-collapse:collapse;width:100%}}
th,td{{border:1px solid #e2e8f0;padding:8px;text-align:left}}
th{{background:#f1f5f9}}</style></head>
<body>
<h1>UBR NMS Integration Test Report</h1>
<p>Total: {summary["total"]} | Passed: {summary["passed"]} |
   Failed: {summary["failed"]} |
   <span style="color:{pass_color}">Pass Rate: {summary["pass_rate"]}%</span></p>
<table>
  <tr><th>Scenario</th><th>Status</th><th>Duration</th><th>Steps</th></tr>
  {"".join(rows)}
</table>
</body></html>"""
