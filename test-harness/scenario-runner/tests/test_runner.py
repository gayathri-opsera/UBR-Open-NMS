"""
Unit tests for the scenario runner engine.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

import asyncio
import json
import pytest
import time
from runner import (
    load_scenario, parse_scenario, evaluate_assertion, _expand_env, _resolve,
    generate_json_report, generate_html_report,
    ScenarioResult, StepResult, StepStatus, ParallelStageResult,
    execute_parallel_stage, poll_until,
)


# ── Scenario parser ───────────────────────────────────────────────────────────

def test_parse_scenario_valid():
    data = {
        "name": "test-scenario",
        "description": "Test",
        "steps": [
            {"name": "step1", "action": "http_get", "url": "http://example.com"},
        ],
    }
    result = parse_scenario(data)
    assert result["name"] == "test-scenario"


def test_parse_scenario_missing_name():
    with pytest.raises(ValueError, match="name"):
        parse_scenario({"steps": []})


def test_parse_scenario_missing_steps():
    with pytest.raises(ValueError, match="steps"):
        parse_scenario({"name": "test"})


def test_parse_scenario_step_missing_name():
    with pytest.raises(ValueError, match="name"):
        parse_scenario({"name": "test", "steps": [{"action": "http_get"}]})


def test_parse_scenario_step_missing_action():
    with pytest.raises(ValueError, match="action"):
        parse_scenario({"name": "test", "steps": [{"name": "s1"}]})


def test_expand_env_with_default(monkeypatch):
    monkeypatch.delenv("MISSING_VAR", raising=False)
    result = _expand_env("url: ${MISSING_VAR:http://localhost}")
    assert result == "url: http://localhost"


def test_expand_env_with_actual_value(monkeypatch):
    monkeypatch.setenv("MY_URL", "http://nms.example.com")
    result = _expand_env("url: ${MY_URL}")
    assert result == "url: http://nms.example.com"


def test_expand_env_no_substitution_needed():
    result = _expand_env("simple: value")
    assert result == "simple: value"


# ── Assertion evaluator ───────────────────────────────────────────────────────

def test_evaluate_assertion_equals_pass():
    ok, detail = evaluate_assertion({"type": "equals", "actual": "200", "expected": "200"}, {})
    assert ok is True


def test_evaluate_assertion_equals_fail():
    ok, detail = evaluate_assertion({"type": "equals", "actual": "404", "expected": "200"}, {})
    assert ok is False


def test_evaluate_assertion_contains_pass():
    ok, detail = evaluate_assertion({"type": "contains", "actual": "alarm: CPE-001", "expected": "CPE-001"}, {})
    assert ok is True


def test_evaluate_assertion_contains_fail():
    ok, detail = evaluate_assertion({"type": "contains", "actual": "no device", "expected": "CPE-001"}, {})
    assert ok is False


def test_evaluate_assertion_gt_pass():
    ok, detail = evaluate_assertion({"type": "gt", "actual": "5", "expected": "3"}, {})
    assert ok is True


def test_evaluate_assertion_gt_fail():
    ok, detail = evaluate_assertion({"type": "gt", "actual": "2", "expected": "3"}, {})
    assert ok is False


def test_evaluate_assertion_gte():
    ok, _ = evaluate_assertion({"type": "gte", "actual": "3", "expected": "3"}, {})
    assert ok is True


def test_evaluate_assertion_not_empty_pass():
    ok, _ = evaluate_assertion({"type": "not_empty", "actual": "some-token"}, {})
    assert ok is True


def test_evaluate_assertion_not_empty_fail():
    ok, _ = evaluate_assertion({"type": "not_empty", "actual": ""}, {})
    assert ok is False


def test_evaluate_assertion_unknown_type():
    ok, detail = evaluate_assertion({"type": "regex", "actual": "foo"}, {})
    assert ok is False
    assert "Unknown" in detail


def test_resolve_context_variable():
    context = {"access_token": "tok-abc123"}
    result = _resolve("${access_token}", context)
    assert result == "tok-abc123"


def test_resolve_literal_passthrough():
    result = _resolve("http://example.com", {})
    assert result == "http://example.com"


# ── Report generator ──────────────────────────────────────────────────────────

def _make_results(scenarios: list) -> list:
    results = []
    for s in scenarios:
        steps = [
            StepResult(name=st["name"], status=StepStatus[st["status"]],
                       duration_ms=st.get("ms", 10))
            for st in s["steps"]
        ]
        overall = StepStatus.PASS if all(st.status == StepStatus.PASS for st in steps) else StepStatus.FAIL
        results.append(ScenarioResult(
            name=s["name"], description=s.get("desc", ""),
            status=overall, duration_ms=sum(st.duration_ms for st in steps),
            steps=steps,
        ))
    return results


def test_json_report_summary_all_pass():
    results = _make_results([
        {"name": "s1", "steps": [{"name": "a", "status": "PASS"}]},
        {"name": "s2", "steps": [{"name": "b", "status": "PASS"}]},
    ])
    report = generate_json_report(results)
    assert report["summary"]["passed"] == 2
    assert report["summary"]["failed"] == 0
    assert report["summary"]["pass_rate"] == 100.0


def test_json_report_summary_partial_fail():
    results = _make_results([
        {"name": "s1", "steps": [{"name": "a", "status": "PASS"}]},
        {"name": "s2", "steps": [{"name": "b", "status": "FAIL"}]},
    ])
    report = generate_json_report(results)
    assert report["summary"]["passed"] == 1
    assert report["summary"]["failed"] == 1
    assert report["summary"]["pass_rate"] == 50.0


def test_json_report_contains_scenario_names():
    results = _make_results([
        {"name": "device-onboarding", "steps": [{"name": "s1", "status": "PASS"}]},
    ])
    report = generate_json_report(results)
    names = [s["name"] for s in report["scenarios"]]
    assert "device-onboarding" in names


def test_html_report_contains_pass_rate():
    results = _make_results([
        {"name": "s1", "steps": [{"name": "a", "status": "PASS"}]},
    ])
    html = generate_html_report(results)
    assert "100.0%" in html
    assert "UBR NMS Integration Test Report" in html


def test_html_report_contains_fail_status():
    results = _make_results([
        {"name": "s1", "steps": [{"name": "a", "status": "FAIL", "ms": 50}]},
    ])
    html = generate_html_report(results)
    assert "FAIL" in html


def test_json_report_empty():
    report = generate_json_report([])
    assert report["summary"]["total"] == 0
    assert report["summary"]["pass_rate"] == 0


# ── Parallel execution tests (WO-042) ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_execute_parallel_stage_all_pass():
    """Test parallel stage execution with all tasks passing."""
    async def task1(ctx):
        await asyncio.sleep(0.01)
        return StepResult(name="task1", status=StepStatus.PASS, duration_ms=10)

    async def task2(ctx):
        await asyncio.sleep(0.01)
        return StepResult(name="task2", status=StepStatus.PASS, duration_ms=10)

    result = await execute_parallel_stage(
        stage_name="test_stage",
        tasks=[task1, task2],
        timeout_seconds=5,
        shared_context={}
    )

    assert result.status == StepStatus.PASS
    assert len(result.parallel_steps) == 2
    assert all(s.status == StepStatus.PASS for s in result.parallel_steps)


@pytest.mark.asyncio
async def test_execute_parallel_stage_one_fails():
    """Test parallel stage execution with one task failing."""
    async def task1(ctx):
        await asyncio.sleep(0.01)
        return StepResult(name="task1", status=StepStatus.PASS, duration_ms=10)

    async def task2(ctx):
        await asyncio.sleep(0.01)
        return StepResult(name="task2", status=StepStatus.FAIL, duration_ms=10, error="Task failed")

    result = await execute_parallel_stage(
        stage_name="test_stage",
        tasks=[task1, task2],
        timeout_seconds=5,
        shared_context={}
    )

    assert result.status == StepStatus.FAIL
    assert len(result.parallel_steps) == 2
    assert result.parallel_steps[0].status == StepStatus.PASS
    assert result.parallel_steps[1].status == StepStatus.FAIL


@pytest.mark.asyncio
async def test_execute_parallel_stage_timeout():
    """Test parallel stage execution with timeout."""
    async def slow_task(ctx):
        await asyncio.sleep(10)  # Longer than timeout
        return StepResult(name="slow", status=StepStatus.PASS, duration_ms=10000)

    result = await execute_parallel_stage(
        stage_name="timeout_stage",
        tasks=[slow_task],
        timeout_seconds=0.1,
        shared_context={}
    )

    assert result.status == StepStatus.FAIL
    assert any("timeout" in s.error.lower() for s in result.parallel_steps if s.error)


@pytest.mark.asyncio
async def test_execute_parallel_stage_shared_context():
    """Test parallel stage execution with shared context."""
    async def task_uses_context(ctx):
        await asyncio.sleep(0.01)
        value = ctx.get("test_key", "default")
        return StepResult(name="context_task", status=StepStatus.PASS, duration_ms=10, details=value)

    context = {"test_key": "test_value"}
    result = await execute_parallel_stage(
        stage_name="context_stage",
        tasks=[task_uses_context],
        timeout_seconds=5,
        shared_context=context
    )

    assert result.status == StepStatus.PASS
    assert result.parallel_steps[0].details == "test_value"


def test_poll_until_success():
    """Test poll_until succeeds when condition becomes true."""
    attempts = [False, False, True]
    call_count = [0]

    def check_fn():
        result = attempts[min(call_count[0], len(attempts) - 1)]
        call_count[0] += 1
        return result, "success"

    success, value, message = poll_until(check_fn, timeout_seconds=2, interval_seconds=0.1, description="test condition")

    assert success is True
    assert value == "success"
    assert "passed" in message.lower()


def test_poll_until_timeout():
    """Test poll_until times out when condition never becomes true."""
    def check_fn():
        return False, "still waiting"

    success, value, message = poll_until(check_fn, timeout_seconds=0.3, interval_seconds=0.1, description="test condition")

    assert success is False
    assert "still waiting" in str(value)
    assert "failed" in message.lower()


def test_poll_until_exception_handling():
    """Test poll_until handles exceptions gracefully."""
    call_count = [0]

    def check_fn():
        call_count[0] += 1
        if call_count[0] < 3:
            raise RuntimeError("Temporary error")
        return True, "recovered"

    success, value, message = poll_until(check_fn, timeout_seconds=2, interval_seconds=0.1, description="test condition")

    assert success is True
    assert value == "recovered"


def test_poll_until_immediate_success():
    """Test poll_until succeeds immediately if condition is already true."""
    def check_fn():
        return True, "immediate"

    success, value, message = poll_until(check_fn, timeout_seconds=1, interval_seconds=0.1, description="test condition")

    assert success is True
    assert value == "immediate"
    assert "passed" in message.lower()


# ── Authority rule assertion tests (WO-042) ───────────────────────────────────

def test_parallel_stage_result_passed_property():
    """Test ParallelStageResult.passed property."""
    steps_pass = [
        StepResult(name="s1", status=StepStatus.PASS, duration_ms=10),
        StepResult(name="s2", status=StepStatus.PASS, duration_ms=10),
    ]
    result = ParallelStageResult(name="stage1", parallel_steps=steps_pass, duration_ms=20, status=StepStatus.PASS)
    assert result.passed is True

    steps_fail = [
        StepResult(name="s1", status=StepStatus.PASS, duration_ms=10),
        StepResult(name="s2", status=StepStatus.FAIL, duration_ms=10),
    ]
    result_fail = ParallelStageResult(name="stage2", parallel_steps=steps_fail, duration_ms=20, status=StepStatus.FAIL)
    assert result_fail.passed is False


def test_scenario_result_with_parallel_stages():
    """Test ScenarioResult can contain parallel stages."""
    steps = [StepResult(name="setup", status=StepStatus.PASS, duration_ms=5)]
    parallel_steps = [
        StepResult(name="task1", status=StepStatus.PASS, duration_ms=10),
        StepResult(name="task2", status=StepStatus.PASS, duration_ms=10),
    ]
    parallel_stage = ParallelStageResult(
        name="concurrent_discovery",
        parallel_steps=parallel_steps,
        duration_ms=15,
        status=StepStatus.PASS
    )

    result = ScenarioResult(
        name="mixed-discovery",
        description="Test mixed discovery",
        status=StepStatus.PASS,
        duration_ms=20,
        steps=steps,
        parallel_stages=[parallel_stage]
    )

    assert len(result.parallel_stages) == 1
    assert result.parallel_stages[0].name == "concurrent_discovery"
    assert result.parallel_stages[0].passed is True
