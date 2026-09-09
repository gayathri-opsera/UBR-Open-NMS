"""
WO-065: Release Acceptance Report Generator

Aggregates validation scenario results and produces an auditable go/no-go
evidence artifact for release candidates.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

from .runner import ScenarioResult, StepStatus


class ReleaseStatus(str, Enum):
    """Overall release candidate status."""
    PASSED = "PASSED"
    FAILED = "FAILED"
    BLOCKED = "BLOCKED"


class FailureCategory(str, Enum):
    """Categorization of failure types."""
    P0_VALIDATION_FAILED = "P0_VALIDATION_FAILED"
    MISSING_EVIDENCE = "MISSING_EVIDENCE"
    TIMEOUT = "TIMEOUT"
    MALFORMED_INPUT = "MALFORMED_INPUT"
    CONFIGURATION_ERROR = "CONFIGURATION_ERROR"


@dataclass
class ValidationResult:
    """Single validation scenario result."""
    scenario_name: str
    requirement_capability: str
    priority: str  # P0, P1, P2, P3
    status: str  # PASS, FAIL, SKIP, BLOCKED, TIMEOUT
    duration_ms: float
    device_count: Optional[int] = None
    failure_category: Optional[FailureCategory] = None
    error_message: Optional[str] = None
    artifact_path: Optional[str] = None
    artifact_checksum: Optional[str] = None


@dataclass
class ReleaseAcceptanceReport:
    """Complete release acceptance artifact."""
    run_id: str
    release_candidate: str
    generated_at: str
    overall_status: ReleaseStatus
    scenarios: List[ValidationResult] = field(default_factory=list)
    environment_metadata: Dict[str, Any] = field(default_factory=dict)
    fixture_versions: Dict[str, str] = field(default_factory=dict)
    failure_summary: Optional[str] = None


# ── Secret redaction ──────────────────────────────────────────────────────────

SENSITIVE_KEYS = {
    "password", "secret", "token", "key", "credential", "hmac", "private_key",
    "certificate", "connection_string", "api_key", "auth_token", "bearer",
    "jwt", "session_id", "access_token", "refresh_token"
}

SENSITIVE_VALUE_PATTERNS = [
    re.compile(r"[A-Za-z0-9+/=]{40,}"),  # Base64-like tokens
    re.compile(r"sk-[A-Za-z0-9]{32,}"),  # API key patterns
    re.compile(r"ghp_[A-Za-z0-9]{36,}"),  # GitHub tokens
    re.compile(r"Bearer\s+[A-Za-z0-9\-._~+/]+=*", re.IGNORECASE),  # Bearer tokens
    re.compile(r"-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----"),  # Private keys
]


def redact_secrets(data: Any) -> Any:
    """
    Recursively redact sensitive values from nested data structures.

    Redacts:
    - Dict keys matching SENSITIVE_KEYS
    - String values matching SENSITIVE_VALUE_PATTERNS
    """
    if isinstance(data, dict):
        return {
            k: "[REDACTED]" if _is_sensitive_key(k) else redact_secrets(v)
            for k, v in data.items()
        }
    elif isinstance(data, list):
        return [redact_secrets(item) for item in data]
    elif isinstance(data, str):
        return _redact_sensitive_string(data)
    else:
        return data


def _is_sensitive_key(key: str) -> bool:
    """Check if a key name indicates sensitive data."""
    key_lower = key.lower()
    return any(sensitive in key_lower for sensitive in SENSITIVE_KEYS)


def _redact_sensitive_string(value: str) -> str:
    """Redact sensitive patterns in string values."""
    for pattern in SENSITIVE_VALUE_PATTERNS:
        if pattern.search(value):
            return "[REDACTED]"
    return value


# ── Checksum calculation ──────────────────────────────────────────────────────

def compute_file_checksum(file_path: str) -> str:
    """Compute SHA256 checksum of a file."""
    sha256 = hashlib.sha256()
    try:
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha256.update(chunk)
        return sha256.hexdigest()
    except FileNotFoundError:
        return "FILE_NOT_FOUND"
    except Exception as e:
        return f"ERROR:{str(e)}"


def compute_content_checksum(content: str) -> str:
    """Compute SHA256 checksum of string content."""
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


# ── Result aggregation ────────────────────────────────────────────────────────

def load_validation_result(file_path: str) -> ValidationResult:
    """
    Load a validation result from a JSON file.

    Expected schema:
    {
        "scenario_name": "device-onboarding",
        "requirement_capability": "UBR Call-Home Discovery",
        "priority": "P0",
        "status": "PASS",
        "duration_ms": 1234.5,
        "device_count": 3,
        "artifact_path": "/path/to/evidence.json"
    }
    """
    try:
        with open(file_path) as f:
            data = json.load(f)
    except FileNotFoundError:
        raise ValueError(f"Validation result file not found: {file_path}")
    except json.JSONDecodeError as e:
        raise ValueError(f"Malformed validation result JSON in {file_path}: {e}")

    # Validate required fields
    required = ["scenario_name", "requirement_capability", "priority", "status", "duration_ms"]
    missing = [field for field in required if field not in data]
    if missing:
        raise ValueError(f"Missing required fields in {file_path}: {missing}")

    # Compute artifact checksum if path provided
    artifact_checksum = None
    artifact_path = data.get("artifact_path")
    if artifact_path:
        artifact_checksum = compute_file_checksum(artifact_path)

    # Categorize failures (check in priority order)
    failure_category = None
    if data["status"] in ("FAIL", "BLOCKED", "TIMEOUT"):
        if data["status"] == "TIMEOUT":
            failure_category = FailureCategory.TIMEOUT
        elif data.get("artifact_path") and artifact_checksum == "FILE_NOT_FOUND":
            failure_category = FailureCategory.MISSING_EVIDENCE
        elif data["priority"] == "P0" and data["status"] == "FAIL":
            failure_category = FailureCategory.P0_VALIDATION_FAILED
        else:
            failure_category = FailureCategory.CONFIGURATION_ERROR

    return ValidationResult(
        scenario_name=data["scenario_name"],
        requirement_capability=data["requirement_capability"],
        priority=data["priority"],
        status=data["status"],
        duration_ms=data["duration_ms"],
        device_count=data.get("device_count"),
        failure_category=failure_category,
        error_message=data.get("error_message"),
        artifact_path=artifact_path,
        artifact_checksum=artifact_checksum,
    )


def aggregate_validation_results(
    result_files: List[str],
    run_id: str,
    release_candidate: str,
    environment: Optional[Dict[str, Any]] = None,
) -> ReleaseAcceptanceReport:
    """
    Aggregate multiple validation results into a release acceptance report.

    Policy:
    - Overall status is FAILED if ANY P0 validation fails, times out, or has missing evidence
    - Overall status is BLOCKED if any validation is BLOCKED
    - Otherwise, overall status is PASSED
    """
    results: List[ValidationResult] = []
    errors: List[str] = []

    # Load each validation result
    for file_path in result_files:
        try:
            result = load_validation_result(file_path)
            results.append(result)
        except ValueError as e:
            errors.append(str(e))
            # Treat malformed input as missing evidence for P0 scenarios
            results.append(ValidationResult(
                scenario_name=f"INVALID:{Path(file_path).name}",
                requirement_capability="Unknown",
                priority="P0",  # Assume P0 to be conservative
                status="FAIL",
                duration_ms=0,
                failure_category=FailureCategory.MALFORMED_INPUT,
                error_message=str(e),
            ))

    # Determine overall status based on severity policy
    overall_status = _determine_overall_status(results)

    # Redact environment metadata
    redacted_env = redact_secrets(environment or {})

    # Generate fixture versions (extract from environment or filenames)
    fixture_versions = _extract_fixture_versions(redacted_env)

    # Generate failure summary if needed
    failure_summary = None
    if overall_status != ReleaseStatus.PASSED:
        failure_summary = _generate_failure_summary(results, errors)

    return ReleaseAcceptanceReport(
        run_id=run_id,
        release_candidate=release_candidate,
        generated_at=datetime.now(timezone.utc).isoformat(),
        overall_status=overall_status,
        scenarios=results,
        environment_metadata=redacted_env,
        fixture_versions=fixture_versions,
        failure_summary=failure_summary,
    )


def _determine_overall_status(results: List[ValidationResult]) -> ReleaseStatus:
    """Apply severity policy to determine overall release status."""
    has_p0_failure = any(
        r.priority == "P0" and r.status in ("FAIL", "TIMEOUT")
        for r in results
    )
    has_missing_evidence = any(
        r.priority == "P0" and r.failure_category == FailureCategory.MISSING_EVIDENCE
        for r in results
    )
    has_blocked = any(r.status == "BLOCKED" for r in results)

    if has_p0_failure or has_missing_evidence:
        return ReleaseStatus.FAILED
    elif has_blocked:
        return ReleaseStatus.BLOCKED
    else:
        return ReleaseStatus.PASSED


def _extract_fixture_versions(environment: Dict[str, Any]) -> Dict[str, str]:
    """Extract fixture and tool versions from environment metadata."""
    versions = {}

    # Extract version-like keys
    for key, value in environment.items():
        if "version" in key.lower() and isinstance(value, str):
            versions[key] = value

    return versions


def _generate_failure_summary(results: List[ValidationResult], errors: List[str]) -> str:
    """Generate human-readable failure summary."""
    lines = []

    # Count failures by category
    p0_failures = [r for r in results if r.priority == "P0" and r.status in ("FAIL", "TIMEOUT")]
    missing_evidence = [r for r in results if r.failure_category == FailureCategory.MISSING_EVIDENCE]
    blocked = [r for r in results if r.status == "BLOCKED"]

    if p0_failures:
        lines.append(f"P0 Validation Failures ({len(p0_failures)}):")
        for r in p0_failures:
            lines.append(f"  - {r.scenario_name}: {r.requirement_capability}")
            if r.error_message:
                lines.append(f"    Error: {r.error_message}")

    if missing_evidence:
        lines.append(f"\nMissing Evidence ({len(missing_evidence)}):")
        for r in missing_evidence:
            lines.append(f"  - {r.scenario_name}: {r.artifact_path}")

    if blocked:
        lines.append(f"\nBlocked Scenarios ({len(blocked)}):")
        for r in blocked:
            lines.append(f"  - {r.scenario_name}")

    if errors:
        lines.append(f"\nAggregation Errors ({len(errors)}):")
        for err in errors[:5]:  # Limit to 5 errors
            lines.append(f"  - {err}")

    return "\n".join(lines)


# ── Report serialization ──────────────────────────────────────────────────────

def serialize_report(report: ReleaseAcceptanceReport) -> str:
    """Serialize report to deterministic JSON."""
    data = {
        "runId": report.run_id,
        "releaseCandidate": report.release_candidate,
        "generatedAt": report.generated_at,
        "overallStatus": report.overall_status.value,
        "scenarios": [
            {
                "scenarioName": r.scenario_name,
                "requirementCapability": r.requirement_capability,
                "priority": r.priority,
                "status": r.status,
                "durationMs": r.duration_ms,
                "deviceCount": r.device_count,
                "failureCategory": r.failure_category.value if r.failure_category else None,
                "errorMessage": r.error_message,
                "artifactPath": r.artifact_path,
                "artifactChecksum": r.artifact_checksum,
            }
            for r in report.scenarios
        ],
        "environmentMetadata": report.environment_metadata,
        "fixtureVersions": report.fixture_versions,
        "failureSummary": report.failure_summary,
    }

    # Sort keys for deterministic output
    return json.dumps(data, indent=2, sort_keys=True)


def write_report(report: ReleaseAcceptanceReport, output_path: str) -> None:
    """Write report to file."""
    report_json = serialize_report(report)
    with open(output_path, "w") as f:
        f.write(report_json)

    # Also write checksum
    checksum = compute_content_checksum(report_json)
    checksum_path = f"{output_path}.sha256"
    with open(checksum_path, "w") as f:
        f.write(f"{checksum}  {Path(output_path).name}\n")


# ── Command interface ─────────────────────────────────────────────────────────

def generate_acceptance_report_from_scenarios(
    scenario_results: List[ScenarioResult],
    run_id: str,
    release_candidate: str,
    output_path: str,
    priority_map: Optional[Dict[str, str]] = None,
) -> ReleaseAcceptanceReport:
    """
    Generate release acceptance report directly from ScenarioResult objects.

    This is the primary integration point with the scenario runner.

    Args:
        scenario_results: List of ScenarioResult from runner.py
        run_id: Unique identifier for this validation run
        release_candidate: Version/tag of release being validated
        output_path: Where to write the report
        priority_map: Optional mapping of scenario names to priorities (defaults to P1)

    Returns:
        ReleaseAcceptanceReport object
    """
    priority_map = priority_map or {}

    # Convert ScenarioResult to ValidationResult
    validation_results: List[ValidationResult] = []

    for scenario in scenario_results:
        priority = priority_map.get(scenario.name, "P1")

        # Map StepStatus to validation status
        status_map = {
            StepStatus.PASS: "PASS",
            StepStatus.FAIL: "FAIL",
            StepStatus.SKIP: "SKIP",
        }
        status = status_map.get(scenario.status, "FAIL")

        # Determine failure category
        failure_category = None
        if status == "FAIL":
            if priority == "P0":
                failure_category = FailureCategory.P0_VALIDATION_FAILED
            else:
                failure_category = FailureCategory.CONFIGURATION_ERROR

        # Extract error message from first failed step
        error_message = None
        if status == "FAIL":
            failed_steps = [s for s in scenario.steps if s.status == StepStatus.FAIL]
            if failed_steps:
                error_message = failed_steps[0].error or failed_steps[0].details

        validation_results.append(ValidationResult(
            scenario_name=scenario.name,
            requirement_capability=scenario.description,
            priority=priority,
            status=status,
            duration_ms=scenario.duration_ms,
            failure_category=failure_category,
            error_message=error_message,
        ))

    # Build report
    overall_status = _determine_overall_status(validation_results)
    failure_summary = None
    if overall_status != ReleaseStatus.PASSED:
        failure_summary = _generate_failure_summary(validation_results, [])

    report = ReleaseAcceptanceReport(
        run_id=run_id,
        release_candidate=release_candidate,
        generated_at=datetime.now(timezone.utc).isoformat(),
        overall_status=overall_status,
        scenarios=validation_results,
        environment_metadata={},
        fixture_versions={},
        failure_summary=failure_summary,
    )

    # Write report
    write_report(report, output_path)

    return report
