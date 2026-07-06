"""
Unit tests for the scenario runner engine.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

import json
import pytest
from runner import (
    load_scenario, parse_scenario, evaluate_assertion, _expand_env, _resolve,
    generate_json_report, generate_html_report,
    ScenarioResult, StepResult, StepStatus,
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
