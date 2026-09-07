"""
Unit tests for WO-065: Release Acceptance Report Generator
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

import json
import pytest
from pathlib import Path

from release_acceptance import (
    ValidationResult, ReleaseAcceptanceReport, ReleaseStatus, FailureCategory,
    redact_secrets, compute_content_checksum, load_validation_result,
    aggregate_validation_results, serialize_report, _determine_overall_status,
)
from runner import ScenarioResult, StepResult, StepStatus


FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


# ── Secret redaction tests ────────────────────────────────────────────────────

def test_redact_secrets_dict_with_sensitive_keys():
    """Redacts dictionary keys matching sensitive patterns."""
    data = {
        "username": "alice",
        "password": "secret123",
        "api_key": "sk-abc123xyz",
        "email": "alice@example.com",
    }
    redacted = redact_secrets(data)
    assert redacted["username"] == "alice"
    assert redacted["password"] == "[REDACTED]"
    assert redacted["api_key"] == "[REDACTED]"
    assert redacted["email"] == "alice@example.com"


def test_redact_secrets_nested_dict():
    """Recursively redacts nested dictionaries."""
    data = {
        "config": {
            "database": {
                "host": "localhost",
                "connection_string": "postgres://user:pass@host/db"
            },
            "auth": {
                "jwt_secret": "supersecret"
            }
        }
    }
    redacted = redact_secrets(data)
    assert redacted["config"]["database"]["host"] == "localhost"
    assert redacted["config"]["database"]["connection_string"] == "[REDACTED]"
    assert redacted["config"]["auth"]["jwt_secret"] == "[REDACTED]"


def test_redact_secrets_list_of_dicts():
    """Redacts secrets in lists of dictionaries."""
    data = [
        {"name": "service1", "token": "tok-abc123"},
        {"name": "service2", "token": "tok-xyz789"},
    ]
    redacted = redact_secrets(data)
    assert redacted[0]["name"] == "service1"
    assert redacted[0]["token"] == "[REDACTED]"
    assert redacted[1]["name"] == "service2"
    assert redacted[1]["token"] == "[REDACTED]"


def test_redact_secrets_bearer_token_value():
    """Redacts Bearer token values in strings."""
    data = {"auth_header": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"}
    redacted = redact_secrets(data)
    assert redacted["auth_header"] == "[REDACTED]"


def test_redact_secrets_private_key():
    """Redacts private key patterns."""
    data = {"cert": "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA"}
    redacted = redact_secrets(data)
    assert redacted["cert"] == "[REDACTED]"


def test_redact_secrets_preserves_non_sensitive():
    """Does not redact non-sensitive data."""
    data = {
        "device_id": "CPE-001",
        "status": "ONLINE",
        "metrics": [1, 2, 3],
        "config": {"enabled": True}
    }
    redacted = redact_secrets(data)
    assert redacted == data


# ── Checksum calculation tests ────────────────────────────────────────────────

def test_compute_content_checksum_deterministic():
    """Checksum is deterministic for same content."""
    content = '{"test": "data"}'
    checksum1 = compute_content_checksum(content)
    checksum2 = compute_content_checksum(content)
    assert checksum1 == checksum2
    assert len(checksum1) == 64  # SHA256 hex length


def test_compute_content_checksum_different_for_different_content():
    """Different content produces different checksums."""
    checksum1 = compute_content_checksum('{"a": 1}')
    checksum2 = compute_content_checksum('{"a": 2}')
    assert checksum1 != checksum2


# ── Validation result loading tests ───────────────────────────────────────────

def test_load_validation_result_all_pass():
    """Loads a passing validation result with all fields."""
    result = load_validation_result(str(FIXTURES_DIR / "validation-all-pass.json"))
    assert result.scenario_name == "device-onboarding"
    assert result.requirement_capability == "UBR Call-Home Discovery"
    assert result.priority == "P0"
    assert result.status == "PASS"
    assert result.duration_ms == 1234.5
    assert result.device_count == 3
    assert result.failure_category is None
    assert result.artifact_checksum is not None


def test_load_validation_result_p0_failure():
    """Categorizes P0 failure correctly."""
    result = load_validation_result(str(FIXTURES_DIR / "validation-p0-failure.json"))
    assert result.status == "FAIL"
    assert result.priority == "P0"
    assert result.failure_category == FailureCategory.P0_VALIDATION_FAILED
    assert result.error_message == "Alarm acknowledgement timeout after 30s"


def test_load_validation_result_missing_evidence():
    """Detects missing artifact files."""
    result = load_validation_result(str(FIXTURES_DIR / "validation-missing-evidence.json"))
    assert result.artifact_path == "/non/existent/evidence.json"
    assert result.artifact_checksum == "FILE_NOT_FOUND"
    assert result.failure_category == FailureCategory.MISSING_EVIDENCE


def test_load_validation_result_skipped():
    """Loads skipped scenario without failure category."""
    result = load_validation_result(str(FIXTURES_DIR / "validation-skipped-noncritical.json"))
    assert result.status == "SKIP"
    assert result.priority == "P2"
    assert result.failure_category is None


def test_load_validation_result_file_not_found():
    """Raises ValueError when result file doesn't exist."""
    with pytest.raises(ValueError, match="not found"):
        load_validation_result("/non/existent/result.json")


def test_load_validation_result_malformed_json():
    """Raises ValueError for malformed JSON."""
    with pytest.raises(ValueError, match="Malformed"):
        load_validation_result(str(FIXTURES_DIR / "validation-malformed.txt"))


def test_load_validation_result_missing_required_fields(tmp_path):
    """Raises ValueError when required fields are missing."""
    incomplete = tmp_path / "incomplete.json"
    incomplete.write_text('{"scenario_name": "test", "status": "PASS"}')
    with pytest.raises(ValueError, match="Missing required fields"):
        load_validation_result(str(incomplete))


# ── Aggregation tests ─────────────────────────────────────────────────────────

def test_aggregate_validation_results_all_pass():
    """Overall status is PASSED when all scenarios pass."""
    result_files = [str(FIXTURES_DIR / "validation-all-pass.json")]
    report = aggregate_validation_results(
        result_files=result_files,
        run_id="run-001",
        release_candidate="v1.2.3",
    )
    assert report.overall_status == ReleaseStatus.PASSED
    assert len(report.scenarios) == 1
    assert report.failure_summary is None


def test_aggregate_validation_results_p0_failure():
    """Overall status is FAILED when P0 scenario fails."""
    result_files = [
        str(FIXTURES_DIR / "validation-all-pass.json"),
        str(FIXTURES_DIR / "validation-p0-failure.json"),
    ]
    report = aggregate_validation_results(
        result_files=result_files,
        run_id="run-002",
        release_candidate="v1.2.4",
    )
    assert report.overall_status == ReleaseStatus.FAILED
    assert len(report.scenarios) == 2
    assert report.failure_summary is not None
    assert "P0 Validation Failures" in report.failure_summary


def test_aggregate_validation_results_missing_evidence():
    """Overall status is FAILED when P0 evidence is missing."""
    result_files = [str(FIXTURES_DIR / "validation-missing-evidence.json")]
    report = aggregate_validation_results(
        result_files=result_files,
        run_id="run-003",
        release_candidate="v1.2.5",
    )
    assert report.overall_status == ReleaseStatus.FAILED
    assert "Missing Evidence" in report.failure_summary


def test_aggregate_validation_results_blocked():
    """Overall status is BLOCKED when any scenario is blocked."""
    result_files = [
        str(FIXTURES_DIR / "validation-all-pass.json"),
        str(FIXTURES_DIR / "validation-blocked.json"),
    ]
    report = aggregate_validation_results(
        result_files=result_files,
        run_id="run-004",
        release_candidate="v1.2.6",
    )
    assert report.overall_status == ReleaseStatus.BLOCKED
    assert "Blocked Scenarios" in report.failure_summary


def test_aggregate_validation_results_skipped_noncritical():
    """Skipped non-P0 scenarios do not fail the release."""
    result_files = [
        str(FIXTURES_DIR / "validation-all-pass.json"),
        str(FIXTURES_DIR / "validation-skipped-noncritical.json"),
    ]
    report = aggregate_validation_results(
        result_files=result_files,
        run_id="run-005",
        release_candidate="v1.2.7",
    )
    assert report.overall_status == ReleaseStatus.PASSED


def test_aggregate_validation_results_malformed_input():
    """Malformed input is treated as P0 failure."""
    result_files = [str(FIXTURES_DIR / "validation-malformed.txt")]
    report = aggregate_validation_results(
        result_files=result_files,
        run_id="run-006",
        release_candidate="v1.2.8",
    )
    assert report.overall_status == ReleaseStatus.FAILED
    assert any(r.failure_category == FailureCategory.MALFORMED_INPUT for r in report.scenarios)
    assert "Aggregation Errors" in report.failure_summary


def test_aggregate_validation_results_environment_redaction():
    """Environment metadata is redacted."""
    result_files = [str(FIXTURES_DIR / "validation-all-pass.json")]
    environment = {
        "test_env": "staging",
        "database_password": "supersecret",
        "api_token": "tok-abc123xyz",
    }
    report = aggregate_validation_results(
        result_files=result_files,
        run_id="run-007",
        release_candidate="v1.2.9",
        environment=environment,
    )
    assert report.environment_metadata["test_env"] == "staging"
    assert report.environment_metadata["database_password"] == "[REDACTED]"
    assert report.environment_metadata["api_token"] == "[REDACTED]"


# ── Status determination tests ────────────────────────────────────────────────

def test_determine_overall_status_all_pass():
    """Returns PASSED when all validations pass."""
    results = [
        ValidationResult("s1", "cap1", "P0", "PASS", 100),
        ValidationResult("s2", "cap2", "P1", "PASS", 200),
    ]
    assert _determine_overall_status(results) == ReleaseStatus.PASSED


def test_determine_overall_status_p0_fail():
    """Returns FAILED when P0 validation fails."""
    results = [
        ValidationResult("s1", "cap1", "P0", "FAIL", 100, failure_category=FailureCategory.P0_VALIDATION_FAILED),
        ValidationResult("s2", "cap2", "P1", "PASS", 200),
    ]
    assert _determine_overall_status(results) == ReleaseStatus.FAILED


def test_determine_overall_status_p1_fail_allowed():
    """Returns PASSED when only P1 fails."""
    results = [
        ValidationResult("s1", "cap1", "P0", "PASS", 100),
        ValidationResult("s2", "cap2", "P1", "FAIL", 200),
    ]
    assert _determine_overall_status(results) == ReleaseStatus.PASSED


def test_determine_overall_status_timeout():
    """Returns FAILED when P0 times out."""
    results = [
        ValidationResult("s1", "cap1", "P0", "TIMEOUT", 30000, failure_category=FailureCategory.TIMEOUT),
    ]
    assert _determine_overall_status(results) == ReleaseStatus.FAILED


def test_determine_overall_status_missing_evidence():
    """Returns FAILED when P0 evidence is missing."""
    results = [
        ValidationResult("s1", "cap1", "P0", "FAIL", 100, failure_category=FailureCategory.MISSING_EVIDENCE),
    ]
    assert _determine_overall_status(results) == ReleaseStatus.FAILED


def test_determine_overall_status_blocked():
    """Returns BLOCKED when any validation is blocked."""
    results = [
        ValidationResult("s1", "cap1", "P0", "PASS", 100),
        ValidationResult("s2", "cap2", "P1", "BLOCKED", 10),
    ]
    assert _determine_overall_status(results) == ReleaseStatus.BLOCKED


# ── Serialization tests ───────────────────────────────────────────────────────

def test_serialize_report_deterministic():
    """Serialization produces deterministic JSON."""
    report = ReleaseAcceptanceReport(
        run_id="run-test",
        release_candidate="v1.0.0",
        generated_at="2026-09-07T10:00:00Z",
        overall_status=ReleaseStatus.PASSED,
        scenarios=[
            ValidationResult("s1", "cap1", "P0", "PASS", 100, device_count=5),
        ],
    )
    json1 = serialize_report(report)
    json2 = serialize_report(report)
    assert json1 == json2


def test_serialize_report_valid_json():
    """Serialized report is valid JSON."""
    report = ReleaseAcceptanceReport(
        run_id="run-test",
        release_candidate="v1.0.0",
        generated_at="2026-09-07T10:00:00Z",
        overall_status=ReleaseStatus.PASSED,
    )
    json_str = serialize_report(report)
    data = json.loads(json_str)  # Should not raise
    assert data["runId"] == "run-test"
    assert data["overallStatus"] == "PASSED"


def test_serialize_report_includes_failure_summary():
    """Serialized report includes failure summary when present."""
    report = ReleaseAcceptanceReport(
        run_id="run-test",
        release_candidate="v1.0.0",
        generated_at="2026-09-07T10:00:00Z",
        overall_status=ReleaseStatus.FAILED,
        failure_summary="P0 Validation Failures (1):\n  - scenario1: description",
    )
    json_str = serialize_report(report)
    data = json.loads(json_str)
    assert "P0 Validation Failures" in data["failureSummary"]
