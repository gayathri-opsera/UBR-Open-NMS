"""FastAPI application for Test Harness - Release Acceptance API (WO-065)."""
import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel

# Note: These are commented out until we can run actual scenarios
# from .runner import ScenarioResult, StepStatus, load_scenario, parse_scenario
from .release_acceptance import (
    ReleaseAcceptanceReport,
    ReleaseStatus,
    ValidationResult,
    FailureCategory,
    serialize_report,
)

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}',
)

app = FastAPI(title="UBR NMS Test Harness - Release Acceptance", version="1.0.0")

# MongoDB connection
mongo_uri = os.environ.get("MONGO_URI", "mongodb://mongo:27017/ubrnms")
client = AsyncIOMotorClient(mongo_uri)
db = client.ubrnms
reports_col = db.release_acceptance_reports


# ── Pydantic models ────────────────────────────────────────────────────────────


class ScenarioSelection(BaseModel):
    """Individual scenario to run in release validation."""

    name: str
    priority: str = "P1"  # P0, P1, P2, P3


class ReleaseAcceptanceRequest(BaseModel):
    """Request to generate a release acceptance report."""

    releaseCandidate: str
    scenarios: List[ScenarioSelection] = []
    environment: Optional[Dict[str, Any]] = None


# ── Health endpoints ───────────────────────────────────────────────────────────


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/readyz")
async def readyz():
    return {"status": "ready"}


# ── WO-065: Release Acceptance Report API ─────────────────────────────────────


@app.post("/api/test-harness/release-acceptance", status_code=202)
async def request_release_acceptance(req: ReleaseAcceptanceRequest):
    """
    Request a release acceptance report for a release candidate.

    The report aggregates validation scenario results and produces a go/no-go
    recommendation based on P0 validation policy.

    Returns immediately with a reportId. Client should poll the status endpoint
    to check for completion.
    """
    report_id = str(uuid.uuid4())
    run_id = f"release-{report_id[:8]}"

    # Store initial report document
    doc = {
        "_id": report_id,
        "runId": run_id,
        "releaseCandidate": req.releaseCandidate,
        "scenarios": [s.model_dump() for s in req.scenarios],
        "environment": req.environment or {},
        "status": "PENDING",
        "requestedAt": datetime.now(timezone.utc),
    }

    await reports_col.insert_one(doc)

    # Trigger async report generation
    asyncio.create_task(
        _generate_release_acceptance_report(
            report_id, run_id, req.releaseCandidate, req.scenarios, req.environment
        )
    )

    return {"reportId": report_id, "status": "PENDING"}


@app.get("/api/test-harness/release-acceptance/{report_id}")
async def get_release_acceptance_status(report_id: str):
    """
    Get the status and results of a release acceptance report.

    Returns:
    - reportId: Unique identifier
    - status: PENDING | COMPLETED | FAILED
    - overallStatus: PASSED | FAILED | BLOCKED (when completed)
    - scenarios: Array of validation results (when completed)
    - failureSummary: Human-readable failure details (when failed)
    """
    doc = await reports_col.find_one({"_id": report_id})
    if not doc:
        raise HTTPException(404, "Release acceptance report not found")

    response = {
        "reportId": report_id,
        "runId": doc.get("runId"),
        "releaseCandidate": doc.get("releaseCandidate"),
        "status": doc.get("status"),
        "requestedAt": doc.get("requestedAt"),
        "completedAt": doc.get("completedAt"),
    }

    # Include results if completed
    if doc.get("status") == "COMPLETED":
        response["overallStatus"] = doc.get("overallStatus")
        response["scenarios"] = doc.get("scenarios_results", [])
        response["failureSummary"] = doc.get("failureSummary")
        response["environmentMetadata"] = doc.get("environmentMetadata", {})
        response["fixtureVersions"] = doc.get("fixtureVersions", {})

    return response


@app.get("/api/test-harness/release-acceptance/{report_id}/download")
async def download_release_acceptance_report(
    report_id: str, actor: str = Query(default="system")
):
    """
    Download the complete release acceptance report as JSON.

    This produces a deterministic, auditable artifact that can be stored
    for compliance and evidence purposes.
    """
    doc = await reports_col.find_one({"_id": report_id})
    if not doc or doc.get("status") != "COMPLETED":
        raise HTTPException(
            404, "Release acceptance report not found or not yet complete"
        )

    # Reconstruct the report data
    report_data = {
        "runId": doc.get("runId"),
        "releaseCandidate": doc.get("releaseCandidate"),
        "generatedAt": doc.get("completedAt"),
        "overallStatus": doc.get("overallStatus"),
        "scenarios": doc.get("scenarios_results", []),
        "environmentMetadata": doc.get("environmentMetadata", {}),
        "fixtureVersions": doc.get("fixtureVersions", {}),
        "failureSummary": doc.get("failureSummary"),
    }

    # Serialize deterministically
    data = json.dumps(report_data, indent=2, sort_keys=True).encode()

    return Response(
        content=data,
        media_type="application/json",
        headers={
            "Content-Disposition": f"attachment; filename=release-acceptance-{report_id}.json"
        },
    )


# ── Report generation logic ────────────────────────────────────────────────────


async def _generate_release_acceptance_report(
    report_id: str,
    run_id: str,
    release_candidate: str,
    scenario_selections: List[ScenarioSelection],
    environment: Optional[Dict[str, Any]],
):
    """
    Generate a release acceptance report by running validation scenarios.

    For now, this creates mock validation results. In production, this would:
    1. Execute each scenario using the scenario runner
    2. Collect results from each scenario
    3. Aggregate into a release acceptance report
    4. Apply P0 validation policy
    """
    try:
        # Simulate scenario execution with mock results
        # TODO: Replace with actual scenario runner integration
        validation_results = await _run_mock_scenarios(scenario_selections)

        # Determine overall status based on P0 policy
        overall_status = _determine_overall_status(validation_results)

        # Generate failure summary if needed
        failure_summary = None
        if overall_status != "PASSED":
            failure_summary = _generate_failure_summary(validation_results)

        # Update report document
        await reports_col.update_one(
            {"_id": report_id},
            {
                "$set": {
                    "status": "COMPLETED",
                    "completedAt": datetime.now(timezone.utc),
                    "overallStatus": overall_status,
                    "scenarios_results": [
                        _validation_result_to_dict(vr) for vr in validation_results
                    ],
                    "environmentMetadata": environment or {},
                    "fixtureVersions": {},
                    "failureSummary": failure_summary,
                }
            },
        )

        logging.info(
            f"Release acceptance report completed: {report_id} - {overall_status}"
        )

    except Exception as e:
        logging.error(f"Failed to generate release acceptance report: {e}")
        await reports_col.update_one(
            {"_id": report_id},
            {
                "$set": {
                    "status": "FAILED",
                    "completedAt": datetime.now(timezone.utc),
                    "error": str(e),
                }
            },
        )


async def _run_mock_scenarios(
    scenario_selections: List[ScenarioSelection],
) -> List[ValidationResult]:
    """
    Mock scenario execution for testing.

    In production, this would:
    1. Load scenario YAML files
    2. Execute each scenario using the runner
    3. Return ValidationResult objects
    """
    # Simulate async execution
    await asyncio.sleep(0.5)

    results = []
    for i, selection in enumerate(scenario_selections):
        # Create mock results - alternate between PASS and FAIL for demo
        if i % 3 == 0 and selection.priority == "P0":
            # Simulate a P0 failure
            results.append(
                ValidationResult(
                    scenario_name=selection.name,
                    requirement_capability=f"Capability for {selection.name}",
                    priority=selection.priority,
                    status="FAIL",
                    duration_ms=1000.0 + (i * 100),
                    failure_category=FailureCategory.P0_VALIDATION_FAILED,
                    error_message=f"Mock failure in scenario {selection.name}",
                )
            )
        else:
            # Simulate success
            results.append(
                ValidationResult(
                    scenario_name=selection.name,
                    requirement_capability=f"Capability for {selection.name}",
                    priority=selection.priority,
                    status="PASS",
                    duration_ms=800.0 + (i * 50),
                )
            )

    return results


def _determine_overall_status(results: List[ValidationResult]) -> str:
    """
    Apply P0 validation policy to determine overall release status.

    Policy:
    - FAILED if any P0 validation fails, times out, or has missing evidence
    - BLOCKED if any validation is BLOCKED
    - PASSED otherwise
    """
    has_p0_failure = any(
        r.priority == "P0" and r.status in ("FAIL", "TIMEOUT") for r in results
    )
    has_missing_evidence = any(
        r.priority == "P0"
        and r.failure_category == FailureCategory.MISSING_EVIDENCE
        for r in results
    )
    has_blocked = any(r.status == "BLOCKED" for r in results)

    if has_p0_failure or has_missing_evidence:
        return "FAILED"
    elif has_blocked:
        return "BLOCKED"
    else:
        return "PASSED"


def _generate_failure_summary(results: List[ValidationResult]) -> str:
    """Generate human-readable failure summary."""
    lines = []

    p0_failures = [
        r for r in results if r.priority == "P0" and r.status in ("FAIL", "TIMEOUT")
    ]
    missing_evidence = [
        r
        for r in results
        if r.failure_category == FailureCategory.MISSING_EVIDENCE
    ]
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
            lines.append(f"  - {r.scenario_name}")

    if blocked:
        lines.append(f"\nBlocked Scenarios ({len(blocked)}):")
        for r in blocked:
            lines.append(f"  - {r.scenario_name}")

    return "\n".join(lines)


def _validation_result_to_dict(vr: ValidationResult) -> Dict[str, Any]:
    """Convert ValidationResult dataclass to dict for MongoDB storage."""
    return {
        "scenarioName": vr.scenario_name,
        "requirementCapability": vr.requirement_capability,
        "priority": vr.priority,
        "status": vr.status,
        "durationMs": vr.duration_ms,
        "deviceCount": vr.device_count,
        "failureCategory": vr.failure_category.value if vr.failure_category else None,
        "errorMessage": vr.error_message,
        "artifactPath": vr.artifact_path,
        "artifactChecksum": vr.artifact_checksum,
    }
